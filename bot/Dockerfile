FROM python:3.12-slim
WORKDIR /app
COPY bot.py .
ENV PYTHONUNBUFFERED=1 DB_PATH=/data/potehastl.db
CMD ["python", "bot.py"]
