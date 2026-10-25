from collections.abc import Callable

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from backend import auth, calls, live_token
from backend.converse import GenerateTurn
from backend.retrieval import routes as retrieval_routes


def create_web_app(
    static_dir: str | None = None,
    call_store: calls.CallStore | None = None,
    mint_token: Callable[..., str] | None = None,
    retriever=None,
    converse: GenerateTurn | None = None,
    oauth_exchange: auth.ExchangeCode | None = None,
) -> FastAPI:
    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    api.add_middleware(GZipMiddleware, minimum_size=1000)

    # Vite hashes asset names, so they can be cached forever; the HTML must always be revalidated to see a deploy.
    @api.middleware("http")
    async def cache_control(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    api.include_router(auth.build_router(oauth_exchange) if oauth_exchange else auth.router)
    if call_store:
        api.include_router(calls.router(call_store))
        if mint_token:
            api.include_router(live_token.router(call_store, mint_token))
        if retriever:
            api.include_router(retrieval_routes.router(call_store, retriever))
        if converse:
            from backend.converse import router as converse_router

            api.include_router(converse_router(call_store, converse))
    # Mounted last so /api routes win.
    if static_dir:
        api.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
    return api
