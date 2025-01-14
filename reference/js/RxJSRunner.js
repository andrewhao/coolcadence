import RxCadence from '../../lib/RxCadence';
import TestDataStream from '../../lib/utils/TestDataStream';
import { Observable } from 'rx';
import Cycle from '@cycle/core';
import { hJSX, makeDOMDriver, p } from '@cycle/dom';
import jQuery from 'jquery';
import CadenceGraph from './cadenceGraph';
window.jQuery = jQuery
import 'jquery-ui';

const START = 'START';
const STOP = 'STOP';
const MOVE = 'MOVE';
const CADENCE = 'CADENCE';
const STARTED = 'STARTED';
const PAUSED = 'PAUSED';
const INIT = 'INIT';
const CHOOSE_HTML5_INPUT = 'CHOOSE_HTML5_INPUT';
const CHOOSE_STUB_INPUT = 'CHOOSE_STUB_INPUT';
const HTML5_INPUT = 'HTML5_INPUT';
const STUB_INPUT = 'STUB_INPUT';
const DEFAULT_INPUT = STUB_INPUT;

function main({ DOM, Motion, StubMotion }) {
  const html5Raw$ = Motion.events.share()
  const stubRaw$ = StubMotion.events.share()

  const selectorMux$ = Observable.merge(
    DOM.select('#chooseHtml5').events('click').map(v => ({ name: CHOOSE_HTML5_INPUT })),
    DOM.select('#chooseStub').events('click').map(v => ({ name: CHOOSE_STUB_INPUT }))
  )

  const inputSelectionState$ = selectorMux$
  .map(action => {
      if (action.name === CHOOSE_HTML5_INPUT) {
        return HTML5_INPUT;
      }
      else {
        return STUB_INPUT;
      }
  })
  .startWith(DEFAULT_INPUT)

  const raw$ = Observable
  .combineLatest(html5Raw$,
                 stubRaw$,
                 inputSelectionState$)
  .map(([html5, stub, choose]) => {
    if (choose === HTML5_INPUT) {
      return html5;
    } else {
      return stub;
    }
  })

  const power$ = RxCadence.convertPower(raw$).share()
  const step$ = RxCadence.detectSteps(power$).share()
  const cadence$ = RxCadence.calculateCadence(step$).share()

  const actions$ = Observable.merge(
    DOM.select('#starter').events('click').map(v => ({ name: START })),
    DOM.select('#stopper').events('click').map(v => ({ name: STOP })),
    cadence$.map(cadenceValue => ({ name: CADENCE, value: cadenceValue.toFixed(2) })),
    raw$.throttle(100).map(motion => ({ name: MOVE, value: motion })),
    DOM.select('#chooseHtml5').events('click').map(v => ({ name: CHOOSE_HTML5_INPUT })),
    DOM.select('#chooseStub').events('click').map(v => ({ name: CHOOSE_STUB_INPUT }))
  )

  const initialState = {
    cadence: '--',
    runState: PAUSED,
    rawMotion: undefined,
    inputChoice: DEFAULT_INPUT,
  }

  const state$ = actions$
  .scan((history, action) => {
    switch(action.name) {
      case START:
        return Object.assign({}, history, { runState: STARTED });
      case STOP:
        return Object.assign({}, history, { runState: PAUSED });
      case MOVE:
        return Object.assign({}, history, { rawMotion: action.value });
      case CADENCE:
        return Object.assign({}, history, { cadence: action.value });
      case CHOOSE_HTML5_INPUT:
        return Object.assign({}, history, { inputChoice: HTML5_INPUT });
      case CHOOSE_STUB_INPUT:
        return Object.assign({}, history, { inputChoice: STUB_INPUT });
      default:
        return history;
    }
  }, initialState)
  .startWith(initialState)
  .map(v => Object.assign(v, {
    stopDisabled: v.runState === PAUSED,
    startDisabled: v.runState === STARTED,
    stubInputChosen: v.inputChoice === STUB_INPUT,
    html5InputChosen: v.inputChoice === HTML5_INPUT,
  }))

  const vtree$ = state$
  .map(state  => {
    return <div>
      <div id="button-group">
        <button id="starter" disabled={state.startDisabled}>Start</button>
        <button id="stopper" disabled={state.stopDisabled}>Pause</button>
      </div>
      <div id="input-selector-group">
        <label><input type="radio" name="inputSelect" checked={state.stubInputChosen} id="chooseStub" /> Recorded Accelerometer</label>
        <label><input type="radio" name="inputSelect" checked={state.html5InputChosen} id="chooseHtml5" /> HTML5 Accelerometer</label>
      </div>
      <div id="dashboard">
        <div class="dashboard-widget">
          <h1>Cadence: <span class="number">{state.cadence}</span> SPM</h1>
        </div>
        <div><small>App state: { state.runState }</small></div>
        <div><small>Input device: { state.inputChoice }</small></div>
        <div id="raw-input"><small><code>{ JSON.stringify(state.rawMotion) }</code></small></div>
      </div>
    </div>
  })

  const shouldPause$ = state$
  .map(state => state.runState === STARTED)

  const rickshawInputs$ = Observable.combineLatest(
    power$.startWith({ power: null }),
    cadence$.startWith(null),
    step$.startWith({ timestamp: null })
  ).map(([power, cadence, step, state]) => ({
      power: power.power,
      tempo: cadence,
      timestamp: step.timestamp,
      yAccel: power.x,
      xAccel: power.y,
      zAccel: power.z,
    })
  )

  const sinks = {
    DOM: vtree$,
    Motion: shouldPause$,
    StubMotion: shouldPause$,
    Rickshaw: rickshawInputs$,
  }
  return sinks
}

window.jQuery(() => {
  const drivers = {
    DOM: makeDOMDriver('#app'),
    Motion: makeMotionDriver(window),
    StubMotion: makeStubMotionDriver(),
    Rickshaw: makeRickshawDriver(document)
  };
  Cycle.run(main, drivers)
});

function makeMotionDriver(win) {
  return function motionDriver(shouldPause$) {
    const source$ = Observable.fromEvent(win, 'devicemotion')
    .map(dm => {
      return {
        x: dm.accelerationIncludingGravity.x,
        y: dm.accelerationIncludingGravity.y,
        z: dm.accelerationIncludingGravity.z,
        time: new Date().getTime(),
      }
    })
    .pausable(shouldPause$)
    return { events: source$ };
  }
}

/**
 * Stub Motion (accelerometer) driver
 *
 * Responsible for simulating a human moving (or running).
 *
 * Input: shouldPause$ stream, indicating whether the driver
 * should continue producing data or whether it should ignore
 * 'live' data on the fixture stream.
 */
function makeStubMotionDriver() {
  return function fakeMotionDriver(shouldPause$) {
    const events$ = Observable
    .fromPromise(jQuery.ajax('../data/samples-1.csv'))
    .concatMap(points => {
      const data$ = TestDataStream('rxjs')
      .pointsAsRealtimeStream(points)
      return data$;
    })
    .pausable(shouldPause$);
    return { events: events$ }
  }
}

/**
 * Rickshaw driver
 *
 * Responsible for rendering the Rickshaw graph. Because
 * Rickshaw manages its own DOM components, we must make our
 * own driver for it.
 *
 * Note that this is a Cycle.js read-only driver. It does not
 * return an Observable; instead it produces its own side effects
 * via its own subscribe() calls.
 */
function makeRickshawDriver(doc) {
  return function rickshawDriver(inputs$) {
    const widgets$ = inputs$
    .take(1)
    .map(_ => {
      const graph = CadenceGraph.render(doc);
      return {
        graph,
        annotator: CadenceGraph.annotator(
          graph,
          doc.getElementById('timeline')
        )
      }
    })
    .share()

    Observable.combineLatest(
      widgets$,
      inputs$
    )
    .distinctUntilChanged(([widgets, inputs]) => inputs.timestamp)
    .subscribe(([widgets, inputs]) => {
      const timeVal = inputs.timestamp / 1000
      widgets.annotator.add(timeVal, "step @ " + new Date(timeVal));
      widgets.annotator.update();
    });

    Observable.combineLatest(
      widgets$,
      inputs$
    )
    .map(([widgets, i]) => {
      return [ widgets, {
        xAccel: i.xAccel,
        yAccel: i.yAccel,
        zAccel: i.zAccel,
        power: i.power,
        tempo: i.tempo
      }]
    })
    .subscribe(([widgets, input]) => {
      widgets.graph.series.addData(input);
      widgets.graph.render();
    });
  }
}
