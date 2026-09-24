import './zod-config';
import { createRoot } from 'react-dom/client';
import { App, type AppMode } from './components/App';
import './styles.css';

export function mountApp(mode: AppMode): void {
  createRoot(document.getElementById('root')!).render(<App mode={mode} />);
}
