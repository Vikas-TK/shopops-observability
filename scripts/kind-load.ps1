# Builds each ShopOps microservice image locally and loads it directly into
# the `shopops` kind cluster's node containers, skipping any service that
# hasn't been scaffolded yet (no services/<name>/Dockerfile).

param(
    [string]$ClusterName = "shopops",
    [string]$Tag = "local"
)

$ErrorActionPreference = "Stop"
$services = @("product-service", "order-service", "payment-service")

foreach ($svc in $services) {
    $dockerfile = "services/$svc/Dockerfile"
    if (-not (Test-Path $dockerfile)) {
        Write-Host "skip: $svc (no $dockerfile yet)"
        continue
    }

    $image = "shopops/${svc}:${Tag}"
    Write-Host "==> building $image"
    docker build -t $image -f $dockerfile "services/$svc"
    if ($LASTEXITCODE -ne 0) { throw "docker build failed for $svc" }

    Write-Host "==> loading $image into kind cluster '$ClusterName'"
    kind load docker-image $image --name $ClusterName
    if ($LASTEXITCODE -ne 0) { throw "kind load failed for $svc" }
}
