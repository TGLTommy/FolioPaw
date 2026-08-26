ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
USER root
RUN cp /bin/true /bin/ollama
