# Custom Camunda runtime image: pinned Camunda base + our startup/config layer.
# Version is a build arg so it stays in lockstep with the client SDK (M7-1: 8.7.6)
# without editing the Dockerfile.
ARG CAMUNDA_VERSION=8.7.6
FROM camunda/zeebe:${CAMUNDA_VERSION}

# Broker config baked in; secrets/endpoints stay env-only (M7-1 rule), never here.
COPY dockerfiles/application.yaml /usr/local/zeebe/config/application.yaml
COPY dockerfiles/startup.sh /usr/local/bin/agent-local-startup.sh

USER root
RUN chmod +x /usr/local/bin/agent-local-startup.sh
USER zeebe

ENTRYPOINT ["/usr/local/bin/agent-local-startup.sh"]
