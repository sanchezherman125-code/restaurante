import asyncio
import weakref

from starlette.types import ASGIApp, Receive, Scope, Send


class DatabaseAdmissionMiddleware:
    """Admite a la vez como máximo tantas peticiones ``/api`` como conexiones tiene el pool.

    Los endpoints y dependencias son síncronos: cada paso (autenticación, endpoint, cierre de la sesión)
    corre en un salto distinto al threadpool y la conexión queda tomada entre saltos. Si hay más
    peticiones que conexiones, las que esperan una conexión ocupan todos los hilos mientras las que ya
    tienen una esperan hilo para continuar: el servidor queda detenido (``idle in transaction``) y
    /health deja de responder. Las peticiones que exceden el límite esperan aquí, en el bucle de eventos,
    sin ocupar hilo ni conexión.
    """

    def __init__(self, app: ASGIApp, limit: int) -> None:
        self.app = app
        self.limit = max(1, limit)
        # Un semáforo por bucle de eventos (en producción hay uno; las pruebas crean varios).
        self._semaphores: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
            weakref.WeakKeyDictionary()
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, send)
            return
        loop = asyncio.get_running_loop()
        semaphore = self._semaphores.get(loop)
        if semaphore is None:
            semaphore = self._semaphores[loop] = asyncio.Semaphore(self.limit)
        async with semaphore:
            await self.app(scope, receive, send)
