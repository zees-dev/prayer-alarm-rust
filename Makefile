
run:
	cargo run

watch:
	cargo watch --quiet --clear --exec 'run --quiet'

build:
	cargo build

build-release:
	cargo build --release

test:
	cargo test

docker-build:
	docker build -t zeeshans/slim:prayer-alarm-rust .

docker-run:
	docker run --rm -it -e PULSE_SERVER=host.docker.internal -p 3000:3000 --mount type=bind,source=${HOME}/.config/pulse,target=/home/pulseaudio/.config/pulse zeeshans/prayer-alarm-rust

docker-build-rpi:
	docker build -t zeeshans/slim:prayer-alarm-rust -f rpi.Dockerfile .

docker-run-rpi:
	docker run --rm -it --device /dev/snd --security-opt seccomp=unconfined -p 3000:3000 zeeshans/slim:prayer-alarm-rust
