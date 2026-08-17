import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MarketingApp } from './MarketingApp';
import './styles.css';

const Root = import.meta.env.MODE === 'marketing' ? MarketingApp : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
