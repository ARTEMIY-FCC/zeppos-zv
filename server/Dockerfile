# Meme server for the watch app (app.py + zv.py): ffmpeg + numpy, nothing else
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir numpy==2.1.3
WORKDIR /app
COPY zv.py app.py ./
ENV CACHE=/data PORT=8791 PUBLIC=1
EXPOSE 8791
CMD ["python3", "-u", "app.py"]
