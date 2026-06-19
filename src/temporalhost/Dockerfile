# Custom Temporal Server runtime image: pinned auto-setup base + our config/startup layer.
# Version is a build arg so it stays in lockstep with the running server we test against
# without editing the Dockerfile (the @temporalio/* TS client is compatible across a range).
ARG TEMPORAL_VERSION=1.25.2
FROM temporalio/auto-setup:${TEMPORAL_VERSION}

# Dynamic config baked in; datastore endpoints/secrets stay env-only (M7-1 rule), never here.
# auto-setup resolves DYNAMIC_CONFIG_FILE_PATH relative to its /etc/temporal workdir.
COPY config/dynamicconfig/agent-local.yaml /etc/temporal/config/dynamicconfig/agent-local.yaml
# Local-authority auth fragment, rendered at boot into config/base.yaml and merged ahead of
# the auto-setup config; the JWKS endpoint stays env-driven so nothing endpoint-y is baked.
COPY config/base_template.yaml /etc/temporal/config/base_template.yaml
# startup.sh is committed +x; COPY preserves the mode, so no in-image chmod is
# needed (the auto-setup base runs non-root and cannot chmod under /usr/local/bin).
COPY dockerfiles/startup.sh /usr/local/bin/agent-local-startup.sh

# Restore the base CMD the ENTRYPOINT override drops; startup.sh forwards it on.
ENTRYPOINT ["/usr/local/bin/agent-local-startup.sh"]
CMD ["autosetup"]
