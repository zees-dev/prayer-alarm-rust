# A simple prayer alarm in Rust

A small side project - a simple prayer alarm in Rust.

I want adhan to be played at the time of prayer at home, I want it automated, I want to have control of the adhan; and I have a RPI lieing around connected to a speaker.

Problem solved.

## How it works

- retrieves prayer times from [Prayer Times API](./src/structs.rs#L207)
  - credits to `http://api.aladhan.com/` for the API
- runs an [axum](https://github.com/tokio-rs/axum) web server on port `3000` - with API endpoints to control the adhan
- a UI is rendered at `http://127.0.0.1/` to show prayer timings and control the adhan timings
  - offers control on mobile devices (somewhat responsive)

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
docker pull zeeshans/slim:prayer-alarm-rust
```

```sh
docker-compose up -d
```
