ARG BASE=ghcr.io/paperclipai/paperclip@sha256:12ae7579165cbf11d8db71ef69cf01ff48660383e78541b6b2eba38939fa30c9
FROM ${BASE}
USER root
WORKDIR /opt/remote-worker-poc/interactive
COPY interactive/package.json interactive/package-lock.json ./
RUN node -e "if (+process.versions.node.split('.')[0] < 22) process.exit(1)" && npm ci --omit=optional --ignore-scripts --no-audit --no-fund
COPY protocol.mjs ../protocol.mjs
COPY interactive/protocol.mjs interactive/broker.mjs ./
USER 1000:1000
ENTRYPOINT ["node", "/opt/remote-worker-poc/interactive/broker.mjs"]
CMD []
