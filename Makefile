
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
