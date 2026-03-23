import React from 'react';
import ReactDOM from 'react-dom/client';

import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/work-sans';
import './styles.css';

import { App } from './ui/App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

