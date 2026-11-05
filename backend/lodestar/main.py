"""Application entry point: ``python -m lodestar.main`` (or ``uvicorn lodestar.main:app``)."""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
import logging.handlers
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, config, live
from .api import auto, market, replay as replay_api, trading, user
from . import replay as _replay  # noqa: F401  (installs the replay clock source)
from .db import init_db
from .ml.engine import predictor


def _setup_logging():
    root = logging.getLogger()
    if any(isinstance(h, logging.handlers.RotatingFileHandler) for h in root.handlers):
        return
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    fh = logging.handlers.RotatingFileHandler(config.LOG_DIR / "lodestar.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    root.addHandler(fh)
    root.addHandler(sh)
    for noisy in ("httpx", "yfinance", "urllib3", "peewee"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _setup_logging()
    init_db()
    user.ensure_default_dashboard()
    predictor.reload()
    tasks = [] if getattr(app.state, "no_background", False) else await live.start_all()
    url = f"http://{config.HOST}:{config.PORT}"
    logging.getLogger("lodestar").info("Lodestar %s started on %s", __version__, url)
    if os.environ.get("LODESTAR_OPEN_BROWSER") == "1":
        import threading
        import webbrowser
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    yield
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="Lodestar", version=__version__, lifespan=lifespan)


@app.middleware("http")
async def require_token(request: Request, call_next):
    """With LODESTAR_API_TOKEN set, every API call needs it. CORS preflights carry no credentials by design."""
    if config.API_TOKEN and request.url.path.startswith("/api") and request.method != "OPTIONS":
        if not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {config.API_TOKEN}"):
            return JSONResponse(status_code=401, content={"detail": "Missing or wrong engine token"})
    return await call_next(request)


# Added after the token check so it wraps it: a 401 still carries CORS headers and the browser can read it.
# The same-origin UI needs no entry here; the Vite dev server and LODESTAR_CORS_ORIGINS (a hosted site) do.
app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:5173", "http://localhost:5173", *config.CORS_ORIGINS],
                   allow_methods=["*"], allow_headers=["*"])
app.include_router(market.router)
app.include_router(trading.router)
app.include_router(user.router)
app.include_router(auto.router)
app.include_router(replay_api.router)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    logging.getLogger("lodestar.api").exception("unhandled error on %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": f"Internal error: {type(exc).__name__}: {exc}"})


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    # Browsers cannot set headers on WebSockets, so the token travels in the query string.
    if config.API_TOKEN and not hmac.compare_digest(websocket.query_params.get("token", ""), config.API_TOKEN):
        await websocket.close(code=4401)
        return
    await live.hub.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # keepalive pings from the client
    except WebSocketDisconnect:
        live.hub.disconnect(websocket)
    except Exception:
        live.hub.disconnect(websocket)


if config.FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=config.FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        f = config.FRONTEND_DIST / path
        if path and f.is_file() and config.FRONTEND_DIST in f.resolve().parents:
            return FileResponse(f)
        return FileResponse(config.FRONTEND_DIST / "index.html")


def run():
    import socket

    import uvicorn
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex((config.HOST, config.PORT)) == 0:
            print(f"\nPort {config.PORT} is already in use. Lodestar may already be running: open http://{config.HOST}:{config.PORT}\n"
                  f"Or set LODESTAR_PORT to another number in the .env file.\n")
            raise SystemExit(1)
    if not config.FRONTEND_DIST.exists():
        print(f"Warning: the interface build was not found at {config.FRONTEND_DIST}. The API will run, but there is no UI.")
    print(f"\n  Lodestar is starting at http://{config.HOST}:{config.PORT}\n  Keep this window open. Press Ctrl+C to stop.\n")
    uvicorn.run("lodestar.main:app", host=config.HOST, port=config.PORT, log_level="warning")


if __name__ == "__main__":
    run()
