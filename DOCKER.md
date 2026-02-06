# Docker Deployment Guide

## Quick Start

### Using Docker Compose (Recommended)

```bash
# Build and start the service
docker-compose up -d

# Check logs
docker-compose logs -f

# Stop the service
docker-compose down
```

### Using Docker Directly

```bash
# Build the image
docker build -t sealos-tty-agent:latest .

# Run the container
docker run -d \
  --name sealos-tty-agent \
  -p 3000:3000 \
  -v $(pwd)/config.json:/app/config.json:ro \
  sealos-tty-agent:latest

# Check logs
docker logs -f sealos-tty-agent

# Stop the container
docker stop sealos-tty-agent
docker rm sealos-tty-agent
```

## Configuration

The application requires a `config.json` file. Create one based on `config.example.json`:

```bash
cp config.example.json config.json
# Edit config.json as needed
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| PORT | number | 3000 | Server port |
| WS_MAX_PAYLOAD | number | 1048576 | Max WebSocket payload size (1MB) |
| WS_HEARTBEAT_INTERVAL_MS | number | 30000 | WebSocket heartbeat interval |
| WS_AUTH_TIMEOUT_MS | number | 10000 | Authentication timeout |
| WS_TICKET_TTL_MS | number | 60000 | Ticket time-to-live |
| WS_TICKET_MAX_KUBECONFIG_BYTES | number | 262144 | Max kubeconfig size (256KB) |
| WS_ALLOWED_ORIGINS | string[] | [] | Allowed CORS origins (empty = all) |
| DEBUG | boolean | false | Enable debug mode |

### Example config.json

```json
{
  "PORT": 3000,
  "WS_ALLOWED_ORIGINS": ["https://your-domain.com"],
  "DEBUG": false
}
```

## Environment Variables

The application uses a config file rather than environment variables. Mount your config file as a volume.

## Port Mapping

- **3000**: HTTP/WebSocket server port

## Health Check

The container includes a built-in health check that monitors HTTP availability on port 3000.

```bash
# Check health status
docker inspect --format='{{.State.Health.Status}}' sealos-tty-agent
```

## Production Deployment

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sealos-tty-agent
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sealos-tty-agent
  template:
    metadata:
      labels:
        app: sealos-tty-agent
    spec:
      containers:
      - name: sealos-tty-agent
        image: sealos-tty-agent:latest
        ports:
        - containerPort: 3000
        volumeMounts:
        - name: config
          mountPath: /app/config.json
          subPath: config.json
          readOnly: true
        livenessProbe:
          httpGet:
            path: /
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
      volumes:
      - name: config
        configMap:
          name: sealos-tty-agent-config
---
apiVersion: v1
kind: Service
metadata:
  name: sealos-tty-agent
spec:
  selector:
    app: sealos-tty-agent
  ports:
  - port: 3000
    targetPort: 3000
```

### Security Considerations

1. **Non-root user**: The container runs as the `node` user (non-root)
2. **Config mount**: Mount config.json as read-only (`:ro`)
3. **CORS**: Configure `WS_ALLOWED_ORIGINS` to restrict WebSocket connections
4. **Network**: Consider using internal networking for the service

## Troubleshooting

### Container won't start

```bash
# Check logs
docker logs sealos-tty-agent

# Common issue: Missing or invalid config.json
# Ensure config.json is mounted and valid JSON
```

### Health check failing

```bash
# Test manually
curl http://localhost:3000/

# Expected: HTTP 200 or appropriate response
```

### WebSocket connection issues

- Verify `WS_ALLOWED_ORIGINS` includes your client origin
- Check if reverse proxy is properly configured for WebSocket upgrade

## Image Details

- **Base image**: node:22-slim
- **Image size**: ~330MB
- **Node.js feature**: Uses `--experimental-strip-types` to run TypeScript directly
