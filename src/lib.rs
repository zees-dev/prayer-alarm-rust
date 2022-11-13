use chrono::Utc;
use rodio::{Decoder, Sink};
use salah::{Coordinates, Date, Parameters, Prayer, PrayerTimes};
use std::fs::File;
use std::io::BufReader;

#[derive(Clone)]
pub struct AdhanService<'a> {
    pub coords: &'a Coordinates,
    pub config: &'a Parameters,
    pub sink: &'a Sink,
}

impl<'a> AdhanService<'a> {
    pub fn new(coords: &'a Coordinates, config: &'a Parameters, sink: &'a Sink) -> Self {
        Self {
            coords,
            config,
            sink,
        }
    }

    pub fn init_prayer_alarm(self) {
        let date_utc: Date<Utc> = chrono::Utc::now().date();
        let prayer_times = PrayerTimes::new(date_utc, *self.coords, *self.config);

        // if next prayer time is not fajr for tomorrow, then process all todays prayers
        while prayer_times.next() != Prayer::FajrTomorrow {
            let (next_prayer, (hours, mins)) = match prayer_times.next() {
                Prayer::Fajr | Prayer::Dhuhr | Prayer::Asr | Prayer::Maghrib | Prayer::Isha => {
                    (prayer_times.next(), prayer_times.time_remaining()) // time till next
                }
                // current prayer is Fajr, skip Sunrise
                Prayer::Sunrise => (
                    Prayer::Dhuhr,
                    get_time_till_prayer(&prayer_times, &Prayer::Dhuhr),
                ),
                // current prayer is Isha, skip Qiyam
                Prayer::Qiyam | Prayer::FajrTomorrow => (
                    Prayer::FajrTomorrow,
                    get_time_till_prayer(&prayer_times, &Prayer::FajrTomorrow),
                ),
            };

            // convert hours and mins to secs
            let secs_till_next_prayer = hours * 3600 + mins * 60;
            println!(
                "Time till {:?} prayer: {:?}s...",
                next_prayer.name(),
                secs_till_next_prayer
            );
            std::thread::sleep(std::time::Duration::from_secs(secs_till_next_prayer as u64));
            println!(
                "Playing adhan {:?} at {:?}...",
                prayer_times.current().name(),
                chrono::Local::now().time().format("%-l:%M %p").to_string()
            );
            self.play_adhan(&next_prayer);
        }

        // println!(
        //     "{}: {}",
        //     Prayer::Fajr.name(),
        //     prayer_times
        //         .time(Prayer::Fajr)
        //         .with_timezone(&chrono::Local)
        //         .format("%-l:%M %p")
        //         .to_string()
        // );

        // call function again to process next day (since next prayer is FajrTomorrow)
        self.init_prayer_alarm();
    }

    pub fn play_adhan(&self, prayer: &Prayer) {
        match prayer {
            Prayer::Fajr => {
                let file = BufReader::new(File::open("audio/sample.mp3").unwrap());
                let source = Decoder::new(file).unwrap();
                self.sink.append(source);
            }
            _ => {
                let file = BufReader::new(File::open("audio/sample.mp3").unwrap());
                let source = Decoder::new(file).unwrap();
                self.sink.append(source);
            }
        }
        self.sink.sleep_until_end();
    }
}

fn get_time_till_prayer(prayer_times: &PrayerTimes, prayer: &Prayer) -> (u32, u32) {
    let next_time = prayer_times.time(*prayer);
    let now = Utc::now();
    let whole: f64 = next_time.signed_duration_since(now).num_seconds() as f64 / 60.0 / 60.0;
    let fract = whole.fract();
    let hours = whole.trunc() as u32;
    let minutes = (fract * 60.0).round() as u32;
    return (hours, minutes);
}
