ARG SPARK_BASE_IMAGE=elysia-breeze-spark-deps:30d6ea28f36e
FROM ${SPARK_BASE_IMAGE}
ARG BREEZE_COMMIT=daa6cb2efe5471f09369229f322d20bb956cb3c3
LABEL org.opencontainers.image.title="Breeze TTS official inference on Spark" \
      org.opencontainers.image.source="https://github.com/breezeblue-ai/breeze-tts" \
      org.opencontainers.image.revision="${BREEZE_COMMIT}"
WORKDIR /opt/breeze-official
ENV PYTHONPATH=/opt/breeze-official:/opt/breeze-pkgs \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
COPY . /opt/breeze-official/
ENTRYPOINT ["python", "-m", "breeze_infer.api"]
CMD ["/models/breeze", "--host", "0.0.0.0", "--port", "7863"]
