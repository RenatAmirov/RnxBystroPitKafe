import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from kitchen import (
    MENU,
    Board,
    BrokerUnavailable,
    Kitchen,
    KitchenSettings,
    Order,
    OrderConflict,
    OrderInput,
    Product,
)

STATIC = Path(__file__).resolve().parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    kitchen = Kitchen(os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1:5673/"))
    app.state.kitchen = kitchen
    worker = asyncio.create_task(kitchen.run())
    try:
        yield
    finally:
        await kitchen.close(worker)


app = FastAPI(title="БыстроПит", description="Касса и табло заказов кафе", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", include_in_schema=False)
async def cashier():
    return FileResponse(STATIC / "index.html")


@app.get("/api/menu", tags=["Касса"])
async def menu() -> list[Product]:
    return list(MENU.values())


@app.post("/api/orders", tags=["Касса"], status_code=status.HTTP_202_ACCEPTED)
async def create_order(body: OrderInput, request: Request) -> Order:
    try:
        return await request.app.state.kitchen.submit(body)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except OrderConflict as error:
        raise HTTPException(409, "Этот идентификатор уже связан с другим заказом.") from error
    except BrokerUnavailable as error:
        raise HTTPException(503, "RabbitMQ недоступен. Попробуйте отправить заказ ещё раз.") from error


@app.get("/api/board", tags=["Кухня"])
async def board(request: Request) -> Board:
    return request.app.state.kitchen.board()


@app.patch("/api/kitchen", tags=["Кухня"])
async def update_kitchen(body: KitchenSettings, request: Request) -> KitchenSettings:
    request.app.state.kitchen.paused = body.paused
    return body
