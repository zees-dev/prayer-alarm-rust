use chrono::{Date, Local, Timelike, Utc};
use islam::pray::{Config, Location, Prayer, PrayerTimes};
use rodio::{Decoder, Sink};
use std::fs::File;
use std::io::BufReader;
use std::ops::Sub;

#[derive(Clone)]
pub struct AdhanService<'a> {
    pub coords: &'a (f32, f32), // latitude, longitude
    pub config: &'a Config,
    pub sink: &'a Sink,
}

impl<'a> AdhanService<'a> {
    pub fn new(coords: &'a (f32, f32), config: &'a Config, sink: &'a Sink) -> Self {
        Self {
            coords,
            config,
            sink,
        }
    }

    pub fn get_prayer_times(&self) -> PrayerTimes {
        let date: Date<Local> = chrono::Local::today();

        // get timezone from via calculating the offset from UTC
        let timezone = chrono::Local::now().offset().local_minus_utc() / 3600;

        PrayerTimes::new(
            date,
            Location::new(self.coords.0, self.coords.1, timezone),
            *self.config,
        )
    }

    pub fn init_prayer_alarm(&self) {
        let today = chrono::Local::today();
        println!("Today is {:#?}", today);

        let prayer_times = self.get_prayer_times();
        // println!("Prayer times {:#?}", prayer_times);
        println!("Prayer times current {:#?}", prayer_times.current());
        println!("Prayer times for {:#?}", prayer_times.next());

        println!("now time {:#?}", chrono::Local::now().time().hour());

        while today == chrono::Local::today() {
            // if next prayer time is not fajr for tomorrow, then process all todays prayers
            let (next_prayer, (hours, mins)) = match prayer_times.current() {
                Prayer::Sherook | Prayer::Dohr | Prayer::Asr | Prayer::Maghreb => {
                    (prayer_times.next(), prayer_times.time_remaining()) // time till next
                }
                // skip Sunrise/Sherook
                Prayer::Fajr => (
                    Prayer::Dohr,
                    get_time_till_prayer(&prayer_times, &Prayer::Dohr),
                ),
                // current prayer is isha, calculate time till fajr for tomorrow
                Prayer::Ishaa => {
                    let duration_secs = if chrono::Local::now().time().hour() < 12 {
                        // before 12pm, this is isha midnight time, calculate time till fajr for today
                        prayer_times.fajr.sub(chrono::Local::now()).num_seconds()
                    } else {
                        // after 12pm (before 12am next day), calculate time till fajr for tomorrow
                        prayer_times
                            .fajr_tomorrow
                            .sub(chrono::Local::now())
                            .num_seconds()
                    };
                    let hours = duration_secs / 3600;
                    let mins = (duration_secs % 3600) / 60;
                    (prayer_times.next(), (hours as u32, mins as u32))
                }
            };

            println!(
                "Currently {:?}; time till {:?} prayer: {:?}:{:?}:00...",
                prayer_times.current().name(),
                next_prayer.name(),
                hours,
                mins,
            );
            let secs_till_prayer = (hours * 60 + mins) * 60;
            std::thread::sleep(std::time::Duration::from_secs(secs_till_prayer as u64));
            println!(
                "Playing adhan {:?} at {:?}...",
                next_prayer.name(),
                chrono::Local::now().time().format("%-l:%M %p").to_string()
            );
            self.play_adhan(&next_prayer);
        }

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
