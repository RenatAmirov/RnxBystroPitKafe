const byId = (id) => document.getElementById(id);
const money = (value) => new Intl.NumberFormat("ru-RU").format(value) + " ₽";
const orderNumber = (order) => "#" + String(order.number).padStart(3, "0");
const orderTime = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

const cart = new Map();
const products = new Map();
const lanes = {
  queued: "Очередь пуста",
  cooking: "Кухня свободна",
  ready: "Пока нет готовых заказов",
};
const checkout = byId("checkout");
const pause = byId("pause");
let connected = false;
let paused = false;
let submitting = false;
let changingPause = false;
let requestId = null;
let boardOrders = "";

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function api(path, options) {
  const response = await fetch(path, { ...options, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "Сервер не принял запрос.");
  }
  return data;
}

function send(path, method, data) {
  return api(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

function feedback(id, message, error = false) {
  const element = byId(id);
  element.textContent = message;
  element.classList.toggle("error", error);
}

function updateControls() {
  checkout.disabled = !cart.size || !connected || submitting;
  checkout.firstElementChild.textContent = submitting ? "Отправляем…" : "Отправить заказ";
  pause.disabled = changingPause;
  pause.classList.toggle("paused", paused);
  byId("pause-label").textContent = paused ? "Запустить кухню" : "Пауза кухни";
  document.querySelectorAll("[data-change]").forEach((button) => {
    const count = cart.get(button.dataset.product) ?? 0;
    button.disabled = submitting || (button.dataset.change === "1" && count >= 20);
  });
}

function quantityButton(product, change, className) {
  const button = node("button", className, change === 1 ? "+" : "−");
  button.type = "button";
  button.dataset.change = change;
  button.dataset.product = product.id;
  button.setAttribute("aria-label", (change === 1 ? "Добавить " : "Убрать ") + product.name);
  return button;
}

function productCard(product) {
  const card = node("article", "product");
  const media = node("div", "product-media");
  const image = node("img");
  image.src = "/static/media/" + product.id + ".webp";
  image.alt = "";
  image.width = 640;
  image.height = 360;
  media.append(image);
  const body = node("div", "product-body");
  const footer = node("div", "product-footer");
  footer.append(node("strong", "price", money(product.price)), quantityButton(product, 1, "add"));
  body.append(node("h3", "", product.name), node("p", "", product.description), footer);
  card.append(media, body);
  return card;
}

async function loadMenu() {
  try {
    const data = await api("/api/menu");
    for (const product of data) products.set(product.id, product);
    const count = data.length;
    const plural = new Intl.PluralRules("ru-RU").select(count);
    byId("menu-count").textContent = count + " " + { one: "позиция", few: "позиции", many: "позиций" }[plural];
    byId("menu").replaceChildren(...data.map(productCard));
    updateControls();
  } catch {
    byId("menu").replaceChildren(node("p", "empty-note", "Не удалось загрузить меню."));
    setTimeout(loadMenu, 3000);
  }
}

function cartLine(product, quantity) {
  const line = node("div", "cart-line");
  const text = node("div", "cart-product");
  text.append(node("strong", "", product.name), node("span", "", money(product.price * quantity)));
  const stepper = node("div", "stepper");
  stepper.append(
    quantityButton(product, -1, "step"), node("span", "", quantity), quantityButton(product, 1, "step"),
  );
  line.append(text, stepper);
  return line;
}

function renderCart() {
  const list = byId("cart-items");
  let count = 0;
  let total = 0;
  const rows = [];
  for (const [id, quantity] of cart) {
    const product = products.get(id);
    count += quantity;
    total += product.price * quantity;
    rows.push(cartLine(product, quantity));
  }
  if (!rows.length) {
    const empty = node("div", "cart-empty");
    const icon = node("span", "receipt-icon");
    icon.setAttribute("aria-hidden", "true");
    empty.append(icon, node("strong", "", "Заказ пока пуст"), node("span", "", "Добавьте блюда из меню"));
    rows.push(empty);
  }
  list.replaceChildren(...rows);
  byId("cart-count").textContent = count;
  byId("cart-total").textContent = money(total);
  updateControls();
}

function changeCart(event) {
  const button = event.target.closest("[data-change]");
  if (!button || button.disabled) return;
  const { product, change } = button.dataset;
  const quantity = (cart.get(product) ?? 0) + Number(change);
  if (quantity > 0) cart.set(product, quantity);
  else cart.delete(product);
  requestId = null;
  feedback("order-feedback", "");
  renderCart();
  if (event.currentTarget.id === "cart-items") {
    const next = event.currentTarget.querySelector(
      `[data-product="${product}"][data-change="${change}"]:not(:disabled)`,
    );
    (next ?? byId("menu").querySelector(`[data-product="${product}"]:not(:disabled)`))?.focus();
  }
}

function renderConnection(isConnected, reachable = true) {
  connected = isConnected;
  const connection = byId("connection");
  connection.classList.toggle("connected", connected);
  connection.classList.toggle("disconnected", !connected);
  const label = connected ? "RabbitMQ подключён" : reachable ? "RabbitMQ недоступен" : "Нет связи с кассой";
  if (byId("connection-label").textContent !== label) byId("connection-label").textContent = label;
  updateControls();
}

function ticket(order) {
  const card = node("article", "ticket");
  const header = node("div", "ticket-heading");
  const time = node("time", "", orderTime.format(new Date(order.created_at)));
  time.dateTime = order.created_at;
  header.append(node("strong", "", orderNumber(order)), time);
  const items = order.items.map((item) => item.name + (item.quantity > 1 ? " × " + item.quantity : ""));
  card.append(header, node("p", "", items.join(", ")));
  return card;
}

function renderBoard(board) {
  renderConnection(board.connected);
  if (!changingPause) paused = board.paused;
  updateControls();

  const next = JSON.stringify(board.orders);
  if (boardOrders === next) return;
  boardOrders = next;
  for (const [status, placeholder] of Object.entries(lanes)) {
    const orders = board.orders.filter((order) => order.status === status);
    byId(status + "-count").textContent = orders.length;
    byId(status + "-list").replaceChildren(
      ...(orders.length ? orders.map(ticket) : [node("p", "empty-note", placeholder)]),
    );
  }
}

async function refreshBoard() {
  try {
    renderBoard(await api("/api/board"));
  } catch {
    renderConnection(false, false);
  }
}

async function poll() {
  await refreshBoard();
  setTimeout(poll, 700);
}

checkout.addEventListener("click", async () => {
  submitting = true;
  requestId ??= crypto.randomUUID();
  updateControls();
  feedback("order-feedback", "");
  try {
    const items = Array.from(cart, ([product_id, quantity]) => ({ product_id, quantity }));
    const order = await send("/api/orders", "POST", { request_id: requestId, items });
    cart.clear();
    requestId = null;
    feedback("order-feedback", `Заказ ${orderNumber(order)} принят`);
    await refreshBoard();
  } catch (error) {
    feedback("order-feedback", "Не удалось отправить заказ. " + error.message, true);
  } finally {
    submitting = false;
    renderCart();
  }
});

pause.addEventListener("click", async () => {
  changingPause = true;
  updateControls();
  feedback("board-feedback", "");
  try {
    const settings = await send("/api/kitchen", "PATCH", { paused: !paused });
    paused = settings.paused;
  } catch {
    feedback("board-feedback", "Не удалось изменить состояние кухни.", true);
  } finally {
    changingPause = false;
    updateControls();
  }
});

const navLinks = document.querySelectorAll(".nav-link");
function updateNavigation() {
  const current = location.hash === "#board" ? "#board" : "#cashier";
  for (const link of navLinks) {
    const active = link.hash === current;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", updateNavigation);
updateNavigation();
byId("menu").addEventListener("click", changeCart);
byId("cart-items").addEventListener("click", changeCart);
renderCart();
loadMenu();
poll();
