import { useState } from 'react';
import { BusTab } from './components/BusTab';
import { FlightsTab } from './components/FlightsTab';

type Tab = 'bus' | 'flights';

const TABS: { id: Tab; label: string }[] = [
  { id: 'bus', label: 'Bus' },
  { id: 'flights', label: 'Flights' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('bus');

  return (
    <div className="app">
      <header className="app-header">
        <h1>Transit Watch</h1>
        <nav className="tabs" role="tablist" aria-label="Dashboard">
          {TABS.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              className="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'bus' ? <BusTab /> : <FlightsTab />}
      </main>
    </div>
  );
}
