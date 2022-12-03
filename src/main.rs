// #![allow(unused)] // For beginning only.

use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post, put},
    Router,
};
use prayer_alarm::{
    data::{DataStore, Database},
    structs::{Params, Prayer, PrayerTime},
    AdhanService,
};
use serde_json::{json, Value};
use std::sync::Arc;

// // get month and/or year if any params are None
// let (month, year) = match (self.month, self.year) {
//     (Some(m), Some(y)) => (m, y),
//     (Some(m), None) => (m, chrono::Local::now().year() as u16),
//     (None, Some(y)) => (chrono::Local::now().month() as u8, y),
//     _ => {
//         let dt = chrono::Local::now();
//         (dt.month() as u8, dt.year() as u16)
//     }
// };

// // convert prayer timings (5) to 8 tunable timing query params
// let tune_params = match self.offsets {
//     Some((fajr, dhuhr, asr, maghrib, isha)) => {
//         format!("0,{},0,{},{},{},0,{}", fajr, dhuhr, asr, maghrib, isha)
//     }
//     None => "0,0,0,0,0,0,0,0".to_string(),
// };

#[tokio::main]
async fn main() {
    // TODO clap

    tracing_subscriber::fmt::init();

    let (tx, rx) = crossbeam_channel::unbounded();

    let database: Arc<dyn Database<PrayerTime, Key = String>> =
        Arc::new(DataStore::<PrayerTime>::new());
    let params = Params::new("Auckland", "NewZealand");

    let service = AdhanService {
        params,
        database: Arc::clone(&database),
        receiver: rx,
    };

    // TODO: use tokio::spawn
    std::thread::spawn(move || service.init_prayer_alarm());

    let app = Router::new()
        .route("/", get(|| async { "Hello, World!" }))
        .route("/health", get(health))
        .route("/timings", get(get_timings))
        .route("/timings/:date/:prayer", put(put_timings_prayer))
        .route("/halt", post(move |_: String| stop_adhan(tx)))
        .with_state(database);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 3000));
    tracing::info!("listening on {}....", addr);
    axum::Server::bind(&addr)
        .serve(app.into_make_service())
        .await
        .unwrap();
}

// `curl -X GET http://localhost:3000/health`
async fn health() -> Json<Value> {
    Json(json!({ "status": "up" }))
}

// `curl -X GET http://localhost:3000/timings`
async fn get_timings(
    State(database): State<Arc<dyn Database<PrayerTime, Key = String>>>,
) -> impl IntoResponse {
    let prayer_times = database.get_all();
    Json(prayer_times)
}

#[derive(serde::Deserialize)]
struct UpdatePrayerTiming {
    play_adhan: bool,
}

// `curl -X PUT -H "Content-Type: application/json" --data '{"play_adhan": false}' http://localhost:3000/timings/2022-12-31/fajr`
async fn put_timings_prayer(
    Path((prayer_date, prayer)): Path<(String, String)>,
    State(database): State<Arc<dyn Database<PrayerTime, Key = String>>>,
    Json(payload): Json<UpdatePrayerTiming>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let mut prayer_time = database
        .get(&prayer_date)
        .ok_or((StatusCode::NOT_FOUND, "failed".to_owned()))?;

    let prayer: Prayer = Prayer::from_str(prayer.as_str())
        .ok_or((StatusCode::BAD_REQUEST, "invalid prayer name".to_owned()))?;

    prayer_time.play_adhan.insert(prayer, payload.play_adhan);
    database.set(&prayer_date, &prayer_time);
    Ok((StatusCode::ACCEPTED, "success"))
}

// `curl -X POST http://localhost:3000/halt`
// Note: post request takes empty payload
async fn stop_adhan(sender: crossbeam_channel::Sender<()>) -> impl IntoResponse {
    tracing::warn!("stopping running adhan...");
    sender.send(()).unwrap();
    (StatusCode::ACCEPTED, ())
}
