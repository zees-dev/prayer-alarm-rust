// Use once_cell for creating a global variable e.g. our DATA.
use once_cell::sync::Lazy;

// Use Mutex for thread-safe access to a variable e.g. our DATA.
use std::sync::Mutex;

// Use BtreeMap for storing data as key-value pairs, sorted by key
use std::collections::BTreeMap;

pub trait Database<V>: Sync + Send {
    type Key;
    fn get_all(&self) -> Vec<V>;
    fn get(&self, key: &Self::Key) -> Option<V>;
    fn set_all(&self, keys: &Vec<Self::Key>, values: &Vec<V>);
    fn set(&self, key: &Self::Key, value: &V);
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

pub struct DataStore<V> {
    data: Lazy<Mutex<BTreeMap<String, V>>>,
}

impl<V> DataStore<V> {
    pub fn new() -> Self {
        Self {
            data: Lazy::new(|| Mutex::new(BTreeMap::new())),
        }
    }
}

unsafe impl<V> Sync for DataStore<V> {}
unsafe impl<V> Send for DataStore<V> {}

// Implement the Database trait for the global variable DATA.
impl<V> Database<V> for DataStore<V>
where
    V: std::clone::Clone + std::fmt::Display,
    V: std::fmt::Debug,
{
    type Key = String;

    fn get_all(&self) -> Vec<V> {
        let data = self.data.lock().unwrap();
        data.values().cloned().collect()
    }

    fn get(&self, key: &Self::Key) -> Option<V> {
        let data = self.data.lock().unwrap();
        data.get(key).cloned()
    }

    fn set_all(&self, keys: &Vec<Self::Key>, values: &Vec<V>) {
        let mut data = self.data.lock().unwrap();
        for (key, value) in keys.iter().zip(values.iter()) {
            data.insert(key.to_owned(), value.to_owned());
        }
    }

    fn set(&self, key: &Self::Key, value: &V) {
        let mut data = self.data.lock().unwrap();
        data.insert(key.to_owned(), value.to_owned());
    }
}
