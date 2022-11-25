// Use once_cell for creating a global variable e.g. our DATA.
use once_cell::sync::Lazy;

// Use Mutex for thread-safe access to a variable e.g. our DATA.
use std::sync::Mutex;

// Use HashMap for storing data as key-value pairs e.g. our DATA.
use std::collections::HashMap;

pub trait Database<T>: Sync + Send {
    fn get_all(&self) -> Vec<T>;
    fn get(&self, key: &str) -> Option<T>;
    fn set_all(&self, values: Vec<T>);
    fn set(&self, value: T);
}

// Create a data store as a global variable with `Lazy` and `Mutex`.
//
// This demo implementation uses a `HashMap` for ease and speed.
// The map key is a primary key for lookup; the map value is a Book.
//
// To access data, create a thread, spawn it, and acquire the lock:
//
// ```
// async fn example() {
//     thread::spawn(move || {
//         let data = DATA.lock().unwrap();
//         …
// }).join().unwrap()
// ```

pub struct DataStore<T> {
    data: Lazy<Mutex<HashMap<String, T>>>,
}

impl<T> DataStore<T> {
    pub fn new() -> Self {
        Self {
            data: Lazy::new(|| Mutex::new(HashMap::new())),
        }
    }
}

unsafe impl<T> Sync for DataStore<T> {}
unsafe impl<T> Send for DataStore<T> {}

// Implement the Database trait for the global variable DATA.
impl<T: std::clone::Clone + std::fmt::Display> Database<T> for DataStore<T> {
    fn get_all(&self) -> Vec<T> {
        let data = self.data.lock().unwrap();
        data.values().cloned().collect()
    }

    fn get(&self, key: &str) -> Option<T> {
        let data = self.data.lock().unwrap();
        data.get(key).cloned()
    }

    fn set_all(&self, value: Vec<T>) {
        let mut data = self.data.lock().unwrap();
        for v in value {
            data.insert(v.to_string(), v);
        }
    }

    fn set(&self, value: T) {
        let mut data = self.data.lock().unwrap();
        data.insert(value.to_string(), value);
    }
}
