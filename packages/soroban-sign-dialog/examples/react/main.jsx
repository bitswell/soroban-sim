import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { loadRequest, report } from '../shared.js';

const request = await loadRequest();
createRoot(document.getElementById('root')).render(<App request={request} report={report} />);
