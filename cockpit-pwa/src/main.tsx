import { render } from 'preact';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('missing #app mount point');
render(<App />, root);
