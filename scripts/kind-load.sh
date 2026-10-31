#!/usr/bin/env bash
# Builds each ShopOps microservice image locally and loads it directly into
# the `shopops` kind cluster's node containers, skipping any service that
# hasn't been scaffolded yet (no services/<name>/Dockerfile).
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-shopops}"
TAG="${TAG:-local}"
SERVICES=(product-service order-service payment-service)

for svc in "${SERVICES[@]}"; do
  dockerfile="services/${svc}/Dockerfile"
  if [[ ! -f "$dockerfile" ]]; then
    echo "skip: ${svc} (no ${dockerfile} yet)"
    continue
  fi

  image="shopops-${svc}:${TAG}"
  echo "==> building ${image}"
  docker build -t "${image}" -f "${dockerfile}" "services/${svc}"

  echo "==> loading ${image} into kind cluster '${CLUSTER_NAME}'"
  kind load docker-image "${image}" --name "${CLUSTER_NAME}"
done
