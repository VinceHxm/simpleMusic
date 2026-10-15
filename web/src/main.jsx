import { render } from 'preact'
import { App } from './App'
import { UpdateBanner } from './components/UpdateBanner'
import { startUpdateCheck } from './update'
import './styles.css'

render(
  <>
    <App />
    <UpdateBanner />
  </>,
  document.getElementById('app'),
)

startUpdateCheck()
