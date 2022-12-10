# Build rust binary - for platform linux/arm/v7
FROM --platform=linux/arm/v7 rust:latest AS builder

RUN apt update && apt install -y --no-install-recommends libasound2-dev && rm -rf /var/lib/apt/lists/*

RUN rustup toolchain install nightly

# https://github.com/rust-lang/cargo/issues/10781#issuecomment-1163829239
# https://blog.rust-lang.org/2022/06/22/sparse-registry-testing.html
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true CARGO_UNSTABLE_SPARSE_REGISTRY=true

WORKDIR /app
COPY ./ ./
RUN cargo +nightly build --release

# --------------------------------------------------------------------------------------------------------------------------------
# Copy rust binary to new image
FROM --platform=linux/arm/v7 debian:bullseye-slim

RUN apt update && apt install -y --no-install-recommends libasound2-dev && rm -rf /var/lib/apt/lists/*

ARG TZ=Pacific/Auckland
ENV TZ=${TZ}

WORKDIR /root
COPY --from=builder /app/target/release/prayer-alarm /root
RUN chmod +x /root/prayer-alarm

ENTRYPOINT ["/root/prayer-alarm"]

# docker run --rm -it --device /dev/snd --security-opt seccomp=unconfined zeeshans/slim:prayer-alarm-rust
