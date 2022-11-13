use rodio::{OutputStream, Sink};
use salah::{Configuration, Coordinates, Madhab, Method};
use std::sync::Arc;

fn main() {
    let (_stream, stream_handle) = OutputStream::try_default().unwrap();
    let sink = Arc::new(Sink::try_new(&stream_handle).unwrap());

    // let sink_ptr = sink.clone();
    // std::thread::spawn(move || {
    //     std::thread::sleep(std::time::Duration::from_secs(1));
    //     sink_ptr.stop();
    // });

    // std::thread::sleep(std::time::Duration::from_secs(5));

    // let params = prayer_alarm::structs::Params::new("Auckland", "NewZealand");

    let service = prayer_alarm::AdhanService {
        coords: &Coordinates::new(-36.8501, 174.7645),
        config: &Configuration::with(Method::MuslimWorldLeague, Madhab::Hanafi),
        sink: &sink,
    };
    service.init_prayer_alarm();
}
