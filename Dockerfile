FROM rust:latest AS builder

RUN apt update && apt install -y --no-install-recommends libasound2-dev && rm -rf /var/lib/apt/lists/*

RUN rustup toolchain install nightly

# https://github.com/rust-lang/cargo/issues/10781#issuecomment-1163829239
# https://blog.rust-lang.org/2022/06/22/sparse-registry-testing.html
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true CARGO_UNSTABLE_SPARSE_REGISTRY=true

WORKDIR /app
COPY . ./
RUN cargo +nightly build --release

# --------------------------------------------------------------------------------------------------------------------------------
# Copy rust binary to new image
FROM debian:bullseye-slim

RUN apt update && apt install -y --no-install-recommends \
  libasound2-dev \
  pulseaudio \
  alsa-utils \
  && rm -rf /var/lib/apt/lists/*

# based on https://git.j3ss.co/dockerfiles/+/c160d3c94f58eca47c5d4b3fbfd15692a96be8a9/pulseaudio/Dockerfile
ENV HOME /home/pulseaudio
RUN useradd --create-home --home-dir $HOME pulseaudio \
	&& usermod -aG audio,pulse,pulse-access pulseaudio \
	&& chown -R pulseaudio:pulseaudio $HOME
WORKDIR $HOME
USER pulseaudio
USER root

ARG TZ=Pacific/Auckland
ENV TZ=${TZ} PULSE_SERVER=host.docker.internal

COPY --from=builder /app/target/release/prayer-alarm /home/pulseaudio
RUN chmod +x /home/pulseaudio/prayer-alarm
ENTRYPOINT ["/home/pulseaudio/prayer-alarm"]

# play audio using pulseaudio on mac: https://stackoverflow.com/a/50939994/10813908
# docker run --rm -it -e PULSE_SERVER=host.docker.internal --mount type=bind,source=${HOME}/.config/pulse,target=/home/pulseaudio/.config/pulse --entrypoint speaker-test jess/pulseaudio -c 2 -l 1 -t wav

# run image
# docker run --rm -it -e PULSE_SERVER=host.docker.internal --mount type=bind,source=${HOME}/.config/pulse,target=/home/pulseaudio/.config/pulse zeeshans/prayer-alarm-rust bash
# docker run --rm -it -e PULSE_SERVER=host.docker.internal -v ${HOME}/.config/pulse:/home/pulseaudio/.config/pulse zeeshans/prayer-alarm-rust bash
# docker run --rm -it --device /dev/snd zeeshans/prayer-alarm-rust bash

# aplay /usr/share/sounds/alsa/Rear_Center.wav
# find . -type f -name "*.wav"

# --------------------------------------------------------------------------------------------------------------------------------

# # BUILDER
# FROM rust:latest as builder

# RUN rustup target add x86_64-unknown-linux-musl
# RUN apt update && apt install -y musl-tools musl-dev
# RUN update-ca-certificates

# ENV USER=root
# WORKDIR /prayer-alarm
# COPY ./ .
# RUN cargo build --target x86_64-unknown-linux-musl --release

# # FINAL
# FROM scratch

# WORKDIR /app
# COPY --from=builder /build/target/x86_64-unknown-linux-musl/release/prayer-alarm ./

# CMD ["/app/prayer-alarm"]
