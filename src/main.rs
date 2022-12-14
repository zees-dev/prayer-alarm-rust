// #![allow(unused)] // For beginning only.

use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, get_service, post, put},
    Router,
};
use prayer_alarm::{
    data::{DataStore, Database},
    structs::{Params, Prayer, PrayerTime},
    AdhanService, Signal,
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tower_http::{services::ServeDir, trace::TraceLayer};

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

#[derive(Clone)]
struct AppState {
    database: Arc<dyn Database<PrayerTime, Key = String>>,
    tx: crossbeam_channel::Sender<(Signal, Prayer)>,
}

#[tokio::main]
async fn main() {
    // TODO clap

    tracing_subscriber::fmt::init();

    let (tx, rx) = crossbeam_channel::unbounded::<(Signal, Prayer)>();

    let database: Arc<dyn Database<PrayerTime, Key = String>> =
        Arc::new(DataStore::<PrayerTime>::new());

    let state = AppState {
        database: Arc::clone(&database),
        tx: tx.clone(),
    };

    let params = Params::new("Auckland", "NewZealand");
    let service = AdhanService {
        params,
        sender: tx,
        database,
    };

    // TODO: use tokio::spawn
    // tokio::task::spawn(move || service.init_prayer_alarm());
    std::thread::spawn(move || service.init_prayer_alarm());
    std::thread::spawn(move || prayer_alarm::play_adhan(&rx));

    let app = Router::new()
        .nest_service(
            "/",
            get_service(ServeDir::new("./client/dist")).handle_error(|_err| async {
                (StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong...")
            }),
        )
        .route("/health", get(health))
        .route("/timings", get(get_timings).post(post_timings))
        .route("/timings/:date/:prayer", put(put_timings_prayer))
        .route("/play", post(play_adhan))
        .route("/halt", post(stop_adhan))
        .with_state(state);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 3000));
    tracing::info!("listening on {}....", addr);
    axum::Server::bind(&addr)
        .serve(app.layer(TraceLayer::new_for_http()).into_make_service())
        .await
        .unwrap();
}

// `curl -X GET http://localhost:3000/health`
async fn health() -> Json<Value> {
    Json(json!({ "status": "up" }))
}

// `curl -X GET http://localhost:3000/timings`
async fn get_timings(State(state): State<AppState>) -> impl IntoResponse {
    let prayer_times = state.database.get_all();
    Json(prayer_times)
}

#[derive(serde::Deserialize)]
struct UpdatePrayerTiming {
    play_adhan: bool,
}

// `curl -X POST -H "Content-Type: application/json" --data '{"play_adhan": false}' http://localhost:3000/timings`
async fn post_timings(
    State(state): State<AppState>,
    Json(payload): Json<UpdatePrayerTiming>,
) -> impl IntoResponse {
    tracing::info!(
        "setting all prayer times to play_adhan: {}",
        payload.play_adhan
    );

    let modified_prayers_times: Vec<PrayerTime> = state
        .database
        .get_all()
        .iter()
        .map(|prayer_time| {
            // set all values of the play_adhan hashmap to payload
            let play_adhan: HashMap<Prayer, bool> = prayer_time
                .play_adhan
                .iter()
                .map(|(key, _)| (*key, payload.play_adhan))
                .collect();
            PrayerTime {
                play_adhan,
                ..prayer_time.clone()
            }
        })
        .collect();
    let prayer_keys = modified_prayers_times
        .iter()
        .map(|prayer_time| prayer_time.date.to_owned())
        .collect::<Vec<String>>();
    state
        .database
        .set_all(&prayer_keys, &modified_prayers_times);
    Json(json!({ "status": "success" }))
}

// `curl -X PUT -H "Content-Type: application/json" --data '{"play_adhan": false}' http://localhost:3000/timings/2022-12-31/fajr`
async fn put_timings_prayer(
    Path((prayer_date, prayer)): Path<(String, String)>,
    State(state): State<AppState>,
    Json(payload): Json<UpdatePrayerTiming>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let mut prayer_time = state
        .database
        .get(&prayer_date)
        .ok_or((StatusCode::NOT_FOUND, "failed".to_owned()))?;

    let prayer: Prayer = Prayer::from_str(prayer.as_str())
        .ok_or((StatusCode::BAD_REQUEST, "invalid prayer name".to_owned()))?;

    prayer_time.play_adhan.insert(prayer, payload.play_adhan);
    state.database.set(&prayer_date, &prayer_time);
    Ok((StatusCode::ACCEPTED, "success"))
}

// `curl -X POST http://localhost:3000/play`
// Note: post request takes empty payload
async fn play_adhan(State(state): State<AppState>) -> impl IntoResponse {
    tracing::warn!("playing adhan...");
    state.tx.send((Signal::Play, Prayer::Dhuhr)).unwrap();
    (StatusCode::ACCEPTED, ())
}

// `curl -X POST http://localhost:3000/halt`
// Note: post request takes empty payload
async fn stop_adhan(State(state): State<AppState>) -> impl IntoResponse {
    tracing::warn!("stopping running adhan...");
    state.tx.send((Signal::Stop, Prayer::Dhuhr)).unwrap();
    (StatusCode::ACCEPTED, ())
}
