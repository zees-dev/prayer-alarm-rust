use chrono::{Date, Local, Timelike, Utc};
use core::panic;
use islam::pray::{Config, Location, Prayer, PrayerTimes};
use rodio::{Decoder, OutputStream, Sink};
use serde::Serialize;
use std::fs::File;
use std::io::BufReader;
use std::ops::Sub;
use std::sync::Arc;

pub mod data;
use data::Database;

pub struct AdhanService {
    // pub struct AdhanService {
    pub coords: (f32, f32), // latitude, longitude
    pub config: Config,
    pub receiver: crossbeam_channel::Receiver<()>,
    // database: &'a dyn Database<PrayerTime>,
    // database: &'a Arc<dyn Database<PrayerTime>>,
    pub database: Arc<dyn Database<PrayerTime>>,
    // pub database: &'a T,
}

impl AdhanService {
    // impl AdhanService {
    pub fn get_prayer_times(&self) -> PrayerTimes {
        let date: Date<Local> = chrono::Local::today();

        // get timezone from via calculating the offset from UTC
        let timezone = chrono::Local::now().offset().local_minus_utc() / 3600;

        PrayerTimes::new(
            date,
            Location::new(self.coords.0, self.coords.1, timezone),
            self.config,
        )
    }

    pub fn init_prayer_alarm(&self) {
        let today = chrono::Local::today();
        tracing::info!("Today is {:#?}", today);

        let prayer_times = self.get_prayer_times();
        let prayer_times_db = PrayerTime::new_list(&prayer_times);
        self.database.set_all(prayer_times_db);

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

            tracing::info!(
                "Currently {:?}; time till {:?} prayer: {:?}:{:?}:00...",
                prayer_times.current().name(),
                next_prayer.name(),
                hours,
                mins,
            );
            std::thread::sleep(std::time::Duration::from_secs(3));
            self.play_adhan(&next_prayer);
            let secs_till_prayer = (hours * 60 + mins) * 60;
            std::thread::sleep(std::time::Duration::from_secs(secs_till_prayer as u64));
            match self.database.get(&next_prayer.name()) {
                Some(prayer_time) => {
                    if prayer_time.play_adhan {
                        tracing::info!(
                            "Playing adhan {:?} at {:?}...",
                            next_prayer.name(),
                            chrono::Local::now().time().format("%-l:%M %p").to_string()
                        );
                        self.play_adhan(&next_prayer);
                    }
                }
                None => panic!("No prayer time found for {:?}", next_prayer.name()),
            }
        }

        // call function again to process next day (since next prayer is FajrTomorrow)
        self.init_prayer_alarm();
    }

    pub fn play_adhan(&self, prayer: &Prayer) {
        while let Ok(_) = self.receiver.try_recv() {} // empty receiver messages

        let (_stream, stream_handle) = OutputStream::try_default().unwrap();
        let sink = Arc::new(Sink::try_new(&stream_handle).unwrap());

        match prayer {
            Prayer::Fajr => {
                let file = BufReader::new(File::open("audio/sample.mp3").unwrap());
                let source = Decoder::new(file).unwrap();
                sink.append(source);
            }
            _ => {
                let file = BufReader::new(File::open("audio/sample.mp3").unwrap());
                let source = Decoder::new(file).unwrap();
                sink.append(source);
            }
        }

        let receiver = self.receiver.clone();
        let sink_ptr = Arc::clone(&sink);
        std::thread::spawn(move || {
            receiver.recv().unwrap();
            sink_ptr.stop();
        });

        sink.sleep_until_end();
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PrayerTime {
    pub prayer_name: String,
    pub time: String,
    pub play_adhan: bool,
}

impl PrayerTime {
    pub fn new_list(prayer_times: &PrayerTimes) -> Vec<Self> {
        vec![
            Prayer::Fajr,
            Prayer::Dohr,
            Prayer::Asr,
            Prayer::Maghreb,
            Prayer::Ishaa,
        ]
        .iter()
        .map(|p| {
            let time = match p {
                Prayer::Fajr => prayer_times.fajr,
                Prayer::Dohr => prayer_times.dohr,
                Prayer::Asr => prayer_times.asr,
                Prayer::Maghreb => prayer_times.maghreb,
                Prayer::Ishaa => prayer_times.ishaa,
                _ => panic!("Unexpected prayer"),
            };
            PrayerTime {
                prayer_name: p.name().to_lowercase(),
                time: format!("{:?}", time),
                play_adhan: true,
            }
        })
        .collect()
    }
}

impl std::fmt::Display for PrayerTime {
    fn fmt(&self, fmt: &mut std::fmt::Formatter) -> std::fmt::Result {
        fmt.write_str(&self.prayer_name)?;
        Ok(())
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
