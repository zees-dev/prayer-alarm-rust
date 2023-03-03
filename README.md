# A simple prayer alarm in Rust

## Quickstart (RPI)

```sh
docker run --rm -it 
  --name prayer-alarm \
  --device /dev/snd \
  --security-opt seccomp=unconfined \
  -p 3000:3000 \
  zeeshans/slim:prayer-alarm-rust
```

## Build and push image for RPI

```sh
docker build -t zeeshans/slim:prayer-alarm-rust -f rpi.Dockerfile .
```

```sh
docker push zeeshans/slim:prayer-alarm-rust 
```

**Use image on RPI:**

```sh
docker-compose up -d
```
