"""Production entrypoint: exactly one Uvicorn worker, no development reload."""

import logging
import os

import uvicorn

from app.config import settings

if __name__ == "__main__":
    settings.validate_production_security()
    logging.basicConfig(level=settings.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        workers=1,
        proxy_headers=True,
        access_log=False,
        log_level=settings.log_level.lower(),
    )
