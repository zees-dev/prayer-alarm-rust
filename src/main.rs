// #![allow(unused)] // For beginning only.

use axum::{
    extract::{Json, Path},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post, put},
    Extension, Router,
};
use islam::pray::{Config, Madhab, Method};
use prayer_alarm::{
    data::{DataStore, Database},
    AdhanService, PrayerTime,
};
use serde_json::{json, Value};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    // TODO clap

    tracing_subscriber::fmt::init();

    let (tx, rx) = crossbeam_channel::unbounded();

    let database: Arc<dyn Database<PrayerTime>> = Arc::new(DataStore::<PrayerTime>::new());
    let config = Config::new().with(Method::MuslimWorldLeague, Madhab::Hanafi);

    let service = AdhanService {
        coords: (-36.8501, 174.764),
        config,
        database: Arc::clone(&database),
        receiver: rx,
    };

    std::thread::spawn(move || service.init_prayer_alarm());

    let app = Router::new()
        .route("/", get(|| async { "Hello, World!" }))
        .route("/health", get(health))
        .route("/timings", get(get_timings))
        .route("/timings/:prayer", put(put_timings_prayer))
        .route("/halt", post(move |_: String| stop_adhan(tx)))
        .layer(Extension(database));

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
    Extension(database): Extension<Arc<dyn Database<PrayerTime>>>,
) -> impl IntoResponse {
    let prayer_times = database.get_all();
    Json(prayer_times)
}

#[derive(serde::Deserialize)]
struct UpdatePrayerTiming {
    play_adhan: bool,
}

// `curl -X PUT -H "Content-Type: application/json" --data '{"play_adhan": false}' http://localhost:3000/timings/fajr`
async fn put_timings_prayer(
    Path(prayer_name): Path<String>,
    Json(payload): Json<UpdatePrayerTiming>,
    Extension(database): Extension<Arc<dyn Database<PrayerTime>>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let mut prayer_time = database
        .get(&prayer_name)
        .ok_or((StatusCode::NOT_FOUND, "failed".to_owned()))?;
    prayer_time.play_adhan = payload.play_adhan;
    database.set(prayer_time);
    Ok((StatusCode::ACCEPTED, "success"))
}

// `curl -X POST http://localhost:3000/halt`
// Note: post request takes empty payload
async fn stop_adhan(sender: crossbeam_channel::Sender<()>) -> impl IntoResponse {
    tracing::warn!("stopping running adhan...");
    sender.send(()).unwrap();
    (StatusCode::ACCEPTED, ())
}
