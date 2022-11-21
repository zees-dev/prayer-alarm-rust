use islam::pray::{Config, Madhab, Method};
use rodio::{OutputStream, Sink};
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
        coords: &(-36.8501, 174.764),
        config: &Config::new().with(Method::MuslimWorldLeague, Madhab::Hanafi),
        sink: &sink,
    };
    service.init_prayer_alarm();
}
