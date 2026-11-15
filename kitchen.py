import asyncio
import logging
from contextlib import suppress
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID, uuid4

import aio_pika
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class Product(BaseModel):
    id: str
    name: str
    description: str
    price: int
    seconds: float


MENU = {
    product.id: product
    for product in (
        Product(
            id="burger", name="Чизбургер", description="Говядина, чеддер и овощи",
            price=329, seconds=6,
        ),
        Product(
            id="fries", name="Картофель фри", description="Хрустящий, с морской солью",
            price=149, seconds=4,
        ),
        Product(
            id="cola", name="Кола", description="Освежающая, со льдом",
            price=109, seconds=3,
        ),
    )
}


class ItemInput(BaseModel):
    product_id: str
    quantity: int = Field(strict=True, ge=1, le=20)


class OrderInput(BaseModel):
    request_id: UUID
    items: list[ItemInput] = Field(min_length=1, max_length=len(MENU))


class OrderLine(ItemInput):
    name: str
    price: int


class Order(BaseModel):
    id: UUID
    number: int
    items: list[OrderLine]
    total: int
    status: Literal["queued", "cooking", "ready"]
    created_at: datetime


class Board(BaseModel):
    connected: bool
    paused: bool
    orders: list[Order]


class KitchenSettings(BaseModel):
    paused: bool


class BrokerUnavailable(Exception):
    pass


class OrderConflict(Exception):
    pass


class Kitchen:
    def __init__(self, url: str):
        self.url = url
        self.connection: aio_pika.abc.AbstractRobustConnection | None = None
        self.queue: aio_pika.abc.AbstractRobustQueue | None = None
        self.paused = False
        self.orders: dict[UUID, Order] = {}
        self.submitting = asyncio.Lock()
        self.queue_name = f"bystropit.orders.{uuid4().hex[:12]}"

    @property
    def connected(self) -> bool:
        return (
            self.connection is not None
            and self.connection.connected.is_set()
            and self.queue is not None
        )

    async def run(self):
        while True:
            try:
                await self.connect_and_cook()
            except asyncio.CancelledError:
                raise
            except (aio_pika.exceptions.AMQPError, OSError, TimeoutError) as error:
                logger.warning("RabbitMQ unavailable (%s), retrying", type(error).__name__)
                await asyncio.sleep(3)

    async def connect_and_cook(self):
        connection = await aio_pika.connect_robust(self.url, timeout=5)
        async with connection:
            # Use independent channels for publishing and consuming.
            self.publisher = await connection.channel(on_return_raises=True)
            consumer = await connection.channel()
            queue = await consumer.declare_queue(
                self.queue_name, durable=True, arguments={"x-expires": 600_000},
            )
            self.queue = queue
            self.connection = connection
            try:
                while True:
                    await self.cook_next(queue)
                    await asyncio.sleep(0.65)
            except asyncio.CancelledError:
                # The queue expires automatically if the broker is unreachable.
                if self.connected:
                    with suppress(aio_pika.exceptions.AMQPError, TimeoutError, ConnectionError):
                        await queue.delete(timeout=3)
                raise
            finally:
                self.connection = None
                self.queue = None

    async def cook_next(self, queue: aio_pika.abc.AbstractRobustQueue):
        try:
            if self.paused:
                # Keep the queue from expiring while there are no reads.
                await queue.declare(timeout=5)
                return
            message = await queue.get(fail=False, timeout=5)
            if message is None:
                return
            try:
                delivery = Order.model_validate_json(message.body)
            except ValueError:
                logger.warning("Invalid order in the RabbitMQ queue", exc_info=True)
                await message.reject(requeue=False)
                return
            async with message.process(requeue=True):
                # A delivery may arrive before its publisher confirm.
                async with self.submitting:
                    order = self.orders.get(delivery.id)
                if order is None or order.status == "ready":
                    return
                self.orders[order.id] = order.model_copy(update={"status": "cooking"})
                await asyncio.sleep(max(MENU[item.product_id].seconds for item in order.items))
                self.orders[order.id] = order.model_copy(update={"status": "ready"})
        except (aio_pika.exceptions.AMQPError, OSError, TimeoutError):
            logger.warning("RabbitMQ delivery interrupted", exc_info=True)
            await asyncio.sleep(2)

    async def close(self, worker: asyncio.Task):
        worker.cancel()
        with suppress(asyncio.CancelledError):
            await worker

    def board(self) -> Board:
        return Board(
            connected=self.connected,
            paused=self.paused,
            orders=list(reversed(self.orders.values())),
        )

    async def submit(self, request: OrderInput) -> Order:
        items = {item.product_id: item.quantity for item in request.items}
        if len(items) != len(request.items):
            raise ValueError("Укажите каждое блюдо в заказе один раз.")
        if items.keys() - MENU.keys():
            raise ValueError("В заказе есть блюдо, которого нет в меню.")

        lines = [
            OrderLine(product_id=key, quantity=quantity, name=MENU[key].name, price=MENU[key].price)
            for key, quantity in items.items()
        ]
        async with self.submitting:
            existing = self.orders.get(request.request_id)
            if existing is not None:
                if items != {item.product_id: item.quantity for item in existing.items}:
                    raise OrderConflict
                return existing
            if not self.connected:
                raise BrokerUnavailable

            order = Order(
                id=request.request_id,
                number=len(self.orders) + 1,
                items=lines,
                total=sum(item.price * item.quantity for item in lines),
                status="queued",
                created_at=datetime.now(UTC),
            )
            try:
                await self.publisher.default_exchange.publish(
                    aio_pika.Message(
                        body=order.model_dump_json().encode(),
                        content_type="application/json",
                        message_id=str(order.id),
                        delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    ),
                    routing_key=self.queue_name,
                    timeout=5,
                )
            except (aio_pika.exceptions.AMQPError, OSError, TimeoutError) as error:
                raise BrokerUnavailable from error
            self.orders[order.id] = order
            return order
