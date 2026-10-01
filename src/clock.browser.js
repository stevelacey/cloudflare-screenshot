;(() => {
  const real = {
    now: performance.now.bind(performance),
    dateNow: Date.now,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  }
  const origin = real.now()
  const epoch = real.dateNow()
  const timers = new Map()
  const frames = new Map()
  let now = 0
  let id = 0
  let frozen = false

  const call = (fn, args) => {
    try {
      typeof fn === "function" ? fn(...args) : Function(fn)()
    } catch (error) {
      console.error(error)
    }
  }

  const run = (target) => {
    // Capped so a zero-delay interval can't spin forever
    for (let fired = 0; fired < 10000; fired++) {
      let next

      for (const entry of timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) {
          next = entry
        }
      }

      if (!next) {
        break
      }

      const [key, timer] = next

      now = Math.max(now, timer.at)

      if (timer.interval === undefined) {
        timers.delete(key)
      } else {
        timer.at += Math.max(timer.interval, 1)
      }

      call(timer.fn, timer.args)
    }

    now = target

    const callbacks = [...frames.values()]

    frames.clear()

    for (const callback of callbacks) {
      call(callback, [origin + now])
    }
  }

  window.setTimeout = (fn, delay, ...args) => {
    timers.set(++id, { fn, args, at: now + (Number(delay) || 0) })

    return id
  }

  window.setInterval = (fn, delay, ...args) => {
    timers.set(++id, { fn, args, at: now + (Number(delay) || 0), interval: Number(delay) || 0 })

    return id
  }

  window.clearTimeout = window.clearInterval = (key) => timers.delete(key)

  window.requestAnimationFrame = (callback) => {
    frames.set(++id, callback)

    return id
  }

  window.cancelAnimationFrame = (key) => frames.delete(key)

  performance.now = () => origin + now
  Date.now = () => epoch + now

  const tick = () => {
    if (!frozen) {
      run(real.now() - origin)
      real.requestAnimationFrame(tick)
    }
  }

  real.requestAnimationFrame(tick)

  window.__clock = {
    freeze() {
      frozen = true
    },

    // CSS animations run on the real clock, so pause and seek them
    advance(ms) {
      run(now + ms)

      window.__animations ??= new Map()

      for (const animation of document.getAnimations()) {
        if (!window.__animations.has(animation)) {
          window.__animations.set(animation, now - (animation.currentTime ?? 0))
          animation.pause()
        }

        animation.currentTime = now - window.__animations.get(animation)
      }
    },
  }
})()
