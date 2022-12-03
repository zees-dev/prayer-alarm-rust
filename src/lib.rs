use chrono::Datelike;
use reqwest;
use rodio::{Decoder, OutputStream, Sink};
use std::fs::File;
use std::io::BufReader;
use std::sync::Arc;

pub mod structs;
use structs::{Params, Prayer, PrayerTime};

pub mod data;
use data::Database;

pub struct AdhanService<'a> {
    pub params: Params<'a>,
    pub receiver: crossbeam_channel::Receiver<()>,
    pub database: Arc<dyn Database<PrayerTime, Key = String>>,
}

impl<'a> AdhanService<'a> {
    // TODO: use this, return custom errors (api call & response deserialization/parsing)
    fn get_prayer_timings(&self) -> Result<Vec<PrayerTime>, String> {
        let api_url = self.params.to_prayer_timings_url();

        let monthly_prayer_timings: structs::api::PrayerCalendarResponse =
            match reqwest::blocking::get(api_url) {
                Ok(response) => match response.json() {
                    Ok(json) => json,
                    Err(e) => return Err(format!("Error parsing response: {:?}", e)),
                },
                Err(e) => return Err(format!("Error calling API: {:?}", e)),
            };
        let current_date_time = chrono::Local::now().naive_local();

        let prayer_timings: Vec<PrayerTime> = monthly_prayer_timings
            .data
            .iter()
            .filter_map(
                // parse gregorian date using DD-MM-YYYY format
                |data| match chrono::NaiveDate::parse_from_str(
                    &data.date.gregorian.date,
                    "%d-%m-%Y",
                ) {
                    Ok(date) => {
                        // check if day of date is after current day
                        if date.day() >= current_date_time.day() {
                            let mut prayer_time: PrayerTime = data.to_owned().into(); // api response -> PrayerTime

                            // only retain prayer times yet to come
                            prayer_time.timings.retain(|timing_time, _| {
                                let timing_time =
                                    chrono::NaiveTime::parse_from_str(timing_time, "%H:%M:%S")
                                        .unwrap();
                                chrono::NaiveDateTime::new(date, timing_time) >= current_date_time
                            });

                            Some(prayer_time)
                        } else {
                            None
                        }
                    }
                    Err(e) => {
                        tracing::error!("Error parsing date: {:?}", e);
                        None
                    }
                },
            )
            .collect();

        Ok(prayer_timings)
    }

    pub fn init_prayer_alarm(&self) {
        tracing::info!("current time: {:#}", chrono::Local::now().naive_local());

        let prayer_times = self
            .get_prayer_timings()
            .expect("error getting prayer times");
        let prayer_keys = prayer_times
            .iter()
            .map(|prayer_time| prayer_time.date.to_owned())
            .collect::<Vec<String>>();
        self.database.set_all(&prayer_keys, &prayer_times);

        for p in prayer_times {
            // construct datetime from date and prayer time
            for (time, prayer) in p.timings.iter() {
                let datetime = chrono::NaiveDateTime::new(
                    chrono::NaiveDate::parse_from_str(&p.date, "%Y-%m-%d")
                        .expect("error parsing date"),
                    chrono::NaiveTime::parse_from_str(time, "%H:%M:%S")
                        .expect("error parsing time"),
                );
                // loop through timings until you get to next prayer time (in future) - from current time
                let naive_now = chrono::Local::now().naive_local();
                if datetime > naive_now {
                    // calculate time difference between current time and next prayer time
                    let time_diff = datetime - naive_now;
                    let (hours, mins) = (
                        time_diff.num_seconds() / 3600,
                        (time_diff.num_seconds() % 3600) / 60,
                    );
                    tracing::info!(
                        "Time till {:?} adhan ({:?}) - {:?}:{:?}:00...",
                        prayer,
                        datetime,
                        hours,
                        mins,
                    );
                    // sleep for duration
                    std::thread::sleep(time_diff.to_std().unwrap());
                    // get play adhan status from db object; if set to true, play adhan
                    if self
                        .database
                        .get(&p.date)
                        .expect("error getting prayer time")
                        .play_adhan
                        .get(prayer)
                        .expect("error getting play adhan status")
                        .to_owned()
                    {
                        self.play_adhan(prayer);
                    }
                }
            }
        }

        // calculate time till next day
        let current_time = chrono::Local::now().naive_local();
        let tomorrow = chrono::NaiveDateTime::new(
            current_time.date() + chrono::Duration::days(1),
            chrono::NaiveTime::from_hms(0, 0, 0),
        );
        let time_diff = tomorrow - current_time;
        let time_diff_with_offset = time_diff
            .checked_add(&chrono::Duration::minutes(5))
            .unwrap();

        // sleep for duration + 5mins offset (12:05 am) - until next calendar month
        std::thread::sleep(time_diff_with_offset.to_std().unwrap());
    }

    pub fn play_adhan(&self, prayer: &Prayer) {
        while let Ok(_) = self.receiver.try_recv() {} // empty currently queued receiver messages

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

// #[derive(Debug, Clone, Serialize)]
// pub struct PrayerTime {
//     pub prayer_name: String,
//     pub time: String,
//     pub play_adhan: bool,
// }

// impl PrayerTime {
//     pub fn new_list(prayer_times: &PrayerTimes) -> Vec<Self> {
//         vec![
//             Prayer::Fajr,
//             Prayer::Dohr,
//             Prayer::Asr,
//             Prayer::Maghreb,
//             Prayer::Ishaa,
//         ]
//         .iter()
//         .map(|p| {
//             let time = match p {
//                 Prayer::Fajr => prayer_times.fajr,
//                 Prayer::Dohr => prayer_times.dohr,
//                 Prayer::Asr => prayer_times.asr,
//                 Prayer::Maghreb => prayer_times.maghreb,
//                 Prayer::Ishaa => prayer_times.ishaa,
//                 _ => panic!("Unexpected prayer"),
//             };
//             PrayerTime {
//                 prayer_name: p.name().to_lowercase(),
//                 time: format!("{:?}", time),
//                 play_adhan: true,
//             }
//         })
//         .collect()
//     }
// }

// impl std::fmt::Display for PrayerTime {
//     fn fmt(&self, fmt: &mut std::fmt::Formatter) -> std::fmt::Result {
//         fmt.write_str(&self.prayer_name)?;
//         Ok(())
//     }
// }

// fn get_time_till_prayer(prayer_times: &PrayerTimes, prayer: &Prayer) -> (u32, u32) {
//     let next_time = prayer_times.time(*prayer);
//     let now = Utc::now();
//     let whole: f64 = next_time.signed_duration_since(now).num_seconds() as f64 / 60.0 / 60.0;
//     let fract = whole.fract();
//     let hours = whole.trunc() as u32;
//     let minutes = (fract * 60.0).round() as u32;
//     return (hours, minutes);
// }
