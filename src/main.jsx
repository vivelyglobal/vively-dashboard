import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './app/App.jsx';
import './app/globals.js';
import { boot } from './app/boot.js';

createRoot(document.getElementById('root')).render(<App />);
boot();
