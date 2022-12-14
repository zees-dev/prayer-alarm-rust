import { createResource, createMemo, Show } from 'solid-js';
import type { Component } from 'solid-js';

type Adhan = "Fajr" | "Dhuhr" | "Asr" | "Maghrib" | "Isha"
interface Prayer {
  date: string              // "2022-12-29"
  timestamp: number         // 1672257661
  timings: {
    [key: string]: Adhan    // "04:11:00": "Fajr"
  }
  play_adhan: {
    [key in Adhan]: boolean // "Fajr": true,
  }
}
interface FlattenedPrayer {
  date: string
  timestamp: number
  adhan: Adhan
  datetime: Date
  play_adhan: boolean
}
const flattenPrayers = (prayers: Prayer[]): FlattenedPrayer[] => {
  const flattenedPrayers = prayers.flatMap(prayer => {
    const timings = Object.entries(prayer.timings)
      .filter(([, adhan]) => adhan) // filter out any adhans that do not have timings
      .map(([time, adhan]) => ({
        date: prayer.date,
        timestamp: prayer.timestamp,
        adhan,
        datetime: new Date(`${prayer.date} ${time}`),
        play_adhan: prayer.play_adhan[adhan]
      })
    );
    return timings;
  });
  return flattenedPrayers;
}

const setAllPrayerAdhans = async (play_adhan: boolean) => (
  await fetch('/timings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ play_adhan }),
  })
);

const togglePrayerAdhan = async (date: string, adhan: Adhan, play_adhan: boolean) => (
  await fetch(`/timings/${date}/${adhan}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ play_adhan }),
  })
);

const App: Component = () => {
  const [prayersResponse, { mutate, refetch }] = createResource<Prayer[]>(async () => (await fetch(`/timings`)).json());

  const prayers = createMemo(() => flattenPrayers(prayersResponse() ?? []));
  const nextPrayerIndex = createMemo(() => prayers().findIndex(({ datetime }) => datetime >= new Date()));
  const month = createMemo(() => {
    if (prayers().length > 0) {
      return prayers()[0].datetime.toLocaleString('en-US', { month: 'long' });
    }
    return new Date().toLocaleString('en-US', { month: 'long' });
  });

  return (
    <main>
      <h1>Prayer Calendar</h1>
      <div class="calendar-subtitle">
        <h3 class="subtitle">{month()}</h3>
        <button
          class="on"
          on:click={async () => { await setAllPrayerAdhans(true); await refetch(); }}
        >
          ON
        </button>
        <button
          class="off"
          on:click={async () => { await setAllPrayerAdhans(false); await refetch(); }}
        >
          OFF
        </button>
        <button
          class="test"
          on:click={() => fetch('/play', { method: 'POST' })}
        >
          TEST
        </button>
        <button
          class="halt"
          on:click={() => fetch('/halt', { method: 'POST' })}
        >
          HALT
        </button>
      </div>
      {prayersResponse.loading && <div>Loading...</div>}
      {prayers() && (
        <table style="width: 100%;">
          <tr>
            <th>Date</th>
            <th>Adhan</th>
            <th>Time</th>
            <th>Status</th>
          </tr>
          {prayers().map(({ date, adhan, datetime, play_adhan }, index) => (
            <>
              <Show when={adhan === 'Fajr'}><div style={{ display: 'flex', "font-weight": 500, color: 'deeppink' }}>{datetime.toLocaleString('en-US', { weekday: 'long' })}</div></Show>
              <tr
                class:endrow={index === prayers().length - 1}
                class:isnext={index === nextPrayerIndex()}
                class:today={date === new Date().toISOString().split('T')[0]}
              >
                <td>{datetime.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                <td>{adhan}</td>
                <td>{datetime.toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true })}</td>
                <td>
                  <button
                    class:on={play_adhan}
                    class:off={!play_adhan}
                    on:click={async () => { await togglePrayerAdhan(date, adhan, !play_adhan); await refetch(); }}
                  >
                    {play_adhan ? 'ON' : 'OFF'}
                  </button>
                </td>
              </tr>
              <Show when={adhan === 'Isha'}><div style={{ display: 'flex' }}><hr /></div></Show>
            </>
          ))}
        </table>
      )}
      {prayersResponse.error && <p style="color: red">{prayersResponse.error.message}</p>}
    </main>
  );
};

export default App;
