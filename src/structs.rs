use chrono::Datelike;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

// {
//   "code": 200,
//   "status": "OK",
//   "data": [
//     {
//       "timings": {
//         "Fajr": "04:40 (NZDT)",
//         "Sunrise": "06:16 (NZDT)",
//         "Dhuhr": "13:05 (NZDT)",
//         "Asr": "16:49 (NZDT)",
//         "Sunset": "19:53 (NZDT)",
//         "Maghrib": "19:53 (NZDT)",
//         "Isha": "21:24 (NZDT)",
//         "Imsak": "04:30 (NZDT)",
//         "Midnight": "01:05 (NZDT)",
//         "Firstthird": "23:21 (NZDT)",
//         "Lastthird": "02:49 (NZDT)"
//       },
//       "date": {
//         "readable": "01 Nov 2022",
//         "timestamp": "1667246461",
//         "gregorian": {
//           "date": "01-11-2022",
//           "format": "DD-MM-YYYY",
//           "day": "01",
//           "weekday": {
//             "en": "Tuesday"
//           },
//           "month": {
//             "number": 11,
//             "en": "November"
//           },
//           "year": "2022",
//           "designation": {
//             "abbreviated": "AD",
//             "expanded": "Anno Domini"
//           }
//         },
//         "hijri": {
//           "date": "06-04-1444",
//           "format": "DD-MM-YYYY",
//           "day": "06",
//           "weekday": {
//             "en": "Al Thalaata",
//             "ar": "الثلاثاء"
//           },
//           "month": {
//             "number": 4,
//             "en": "Rabīʿ al-thānī",
//             "ar": "رَبيع الثاني"
//           },
//           "year": "1444",
//           "designation": {
//             "abbreviated": "AH",
//             "expanded": "Anno Hegirae"
//           },
//           "holidays": []
//         }
//       },
//       "meta": {
//         "latitude": -36.8484597,
//         "longitude": 174.7633315,
//         "timezone": "Pacific/Auckland",
//         "method": {
//           "id": 3,
//           "name": "Muslim World League",
//           "params": {
//             "Fajr": 18,
//             "Isha": 17
//           },
//           "location": {
//             "latitude": 51.5194682,
//             "longitude": -0.1360365
//           }
//         },
//         "latitudeAdjustmentMethod": "ANGLE_BASED",
//         "midnightMode": "STANDARD",
//         "school": "STANDARD",
//         "offset": {
//           "Imsak": 0,
//           "Fajr": 0,
//           "Sunrise": 0,
//           "Dhuhr": 0,
//           "Asr": 0,
//           "Maghrib": 0,
//           "Sunset": 0,
//           "Isha": 0,
//           "Midnight": 0
//         }
//       }
//     }
//   ]
// }
pub mod api {
    use super::*;

    #[derive(Debug, Deserialize)]
    pub struct PrayerCalendarResponse {
        pub code: u16,
        pub status: String,
        pub data: Vec<PrayerData>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct PrayerData {
        pub timings: Timings,
        pub date: Date,
        pub meta: Meta,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "PascalCase")]
    pub struct Timings {
        pub fajr: String,
        // pub sunrise: String,
        pub dhuhr: String,
        pub asr: String,
        // pub sunset: String,
        pub maghrib: String,
        pub isha: String,
        // pub imsak: String,
        // pub midnight: String,
        // pub firstthird: String,
        // pub lastthird: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct Date {
        pub readable: String,
        pub timestamp: String,
        pub gregorian: Gregorian,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct Gregorian {
        pub date: String,
        pub format: String,
        pub day: String,
        pub weekday: Weekday,
        pub month: Month,
        pub year: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct Weekday {
        pub en: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct Month {
        pub number: u8,
        pub en: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct Meta {
        pub latitude: f64,
        pub longitude: f64,
        pub timezone: String,
        pub offset: Offset,
    }

    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "PascalCase")]
    pub struct Offset {
        pub imsak: u8,
        pub fajr: u8,
        pub sunrise: u8,
        pub dhuhr: u8,
        pub asr: u8,
        pub maghrib: u8,
        pub sunset: u8,
        pub isha: u8,
        pub midnight: u8,
    }
}

#[derive(Debug, Clone)]
pub struct Params<'a> {
    pub city: &'a str,
    pub country: &'a str,
    pub method: u8,
    pub date: chrono::NaiveDate,
    pub offsets: (i8, i8, i8, i8, i8), // fajr, dhuhr, asr, maghrib, isha
}

impl<'a> Params<'a> {
    pub fn new(city: &'a str, country: &'a str) -> Self {
        Self {
            city,
            country,
            method: 3,
            date: chrono::Local::today().naive_local(),
            offsets: (0, 0, 0, 0, 0),
        }
    }
    pub fn to_prayer_timings_url(&self) -> String {
        // convert prayer timings (5) to 8 tunable timing query params
        let (fajr, dhuhr, asr, maghrib, isha) = self.offsets;
        let tune_params = format!("0,{},0,{},{},{},0,{}", fajr, dhuhr, asr, maghrib, isha);

        format!(
            "http://api.aladhan.com/v1/calendarByCity?city={}&country={}&method={}&month={}&year={}&tune={}",
            self.city,
            self.country,
            self.method,
            self.date.month(),
            self.date.year(),
            tune_params,
        )
    }
}

#[derive(Debug, Clone, serde::Serialize, Eq, PartialEq, Hash)]
pub enum Prayer {
    Fajr,
    Dhuhr,
    Asr,
    Maghrib,
    Isha,
}

impl Prayer {
    pub fn from_str(p: impl Into<String>) -> Option<Self> {
        match p.into().to_lowercase().as_str() {
            "fajr" => Some(Self::Fajr),
            "dhuhr" => Some(Self::Dhuhr),
            "asr" => Some(Self::Asr),
            "maghrib" => Some(Self::Maghrib),
            "isha" => Some(Self::Isha),
            _ => None,
        }
    }
    pub fn name(&self) -> String {
        match self {
            Self::Fajr => "Fajr".to_string(),
            Self::Dhuhr => "Dhuhr".to_string(),
            Self::Asr => String::from("Asr"),
            Self::Maghrib => String::from("Maghrib"),
            Self::Isha => String::from("Isha"),
        }
    }
}

impl From<&str> for Prayer {
    fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "fajr" => Self::Fajr,
            "dhuhr" => Self::Dhuhr,
            "asr" => Self::Asr,
            "maghrib" => Self::Maghrib,
            "isha" => Self::Isha,
            _ => panic!("invalid prayer name"),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PrayerTime {
    pub date: String,
    pub timestamp: u32,
    pub timings: BTreeMap<String, Prayer>,
    pub play_adhan: HashMap<Prayer, bool>,
}

impl std::fmt::Display for PrayerTime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut s = String::new();
        for (prayer, time) in &self.timings {
            s.push_str(&format!("{}: {}\n", prayer, time.to_owned().name()));
        }
        write!(f, "{}", s)
    }
}

impl From<api::PrayerData> for PrayerTime {
    fn from(prayer_data: api::PrayerData) -> Self {
        let date = chrono::NaiveDate::parse_from_str(&prayer_data.date.gregorian.date, "%d-%m-%Y")
            .unwrap();

        let timestamp: u32 = prayer_data.date.timestamp.parse().unwrap();
        let timings: BTreeMap<String, Prayer> = serde_json::from_value::<HashMap<String, String>>(
            serde_json::to_value(prayer_data.timings).unwrap(),
        )
        .unwrap()
        .iter()
        .map(|(k, v)| {
            let time = chrono::NaiveTime::parse_from_str(&v[..5], "%H:%M")
                .unwrap()
                .to_string();
            (time, Prayer::from(k.as_str()))
        })
        .collect();

        // create map of prayer adhan bools
        let mut play_adhan = HashMap::new();
        play_adhan.insert(Prayer::Fajr, true);
        play_adhan.insert(Prayer::Dhuhr, true);
        play_adhan.insert(Prayer::Asr, true);
        play_adhan.insert(Prayer::Maghrib, true);
        play_adhan.insert(Prayer::Isha, true);

        PrayerTime {
            date: date.to_string(),
            timestamp,
            timings,
            play_adhan,
        }
    }
}

#[cfg(test)]
mod tests {
    // use super::*;

    #[test]
    fn test_date_last_month_of_year() {
        let date = chrono::NaiveDate::parse_from_str("31-12-2020", "%d-%m-%Y").unwrap();
        // add 1 month to current date
        let next_month_date = date + chrono::Duration::days(1);
        assert_eq!(
            next_month_date,
            chrono::NaiveDate::parse_from_str("01-01-2021", "%d-%m-%Y").unwrap()
        );
    }
}
