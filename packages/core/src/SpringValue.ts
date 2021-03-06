import {
  is,
  each,
  noop,
  isEqual,
  toArray,
  eachProp,
  flushCalls,
  getFluidValue,
  getFluidConfig,
  isAnimatedString,
  FluidValue,
  Globals as G,
} from '@react-spring/shared'
import {
  Animated,
  AnimatedValue,
  AnimatedString,
  getPayload,
  getAnimated,
  setAnimated,
  getAnimatedType,
} from '@react-spring/animated'
import { Lookup } from '@react-spring/types'

import { Animation } from './Animation'
import { mergeConfig } from './AnimationConfig'
import { scheduleProps } from './scheduleProps'
import { runAsync, RunAsyncState, RunAsyncProps, stopAsync } from './runAsync'
import {
  callProp,
  computeGoal,
  matchProp,
  inferTo,
  mergeDefaultProps,
  getDefaultProps,
  isAsyncTo,
  resolveProp,
} from './helpers'
import { FrameValue, isFrameValue } from './FrameValue'
import {
  isAnimating,
  isPaused,
  setPausedBit,
  hasAnimated,
  setActiveBit,
} from './SpringPhase'
import { AnimationRange, AnimationResolver } from './types/internal'
import {
  AsyncResult,
  OnRest,
  SpringUpdate,
  VelocityProp,
  SpringProps,
} from './types'
import {
  getCombinedResult,
  getCancelledResult,
  getFinishedResult,
  getNoopResult,
} from './AnimationResult'

declare const console: any

/**
 * Only numbers, strings, and arrays of numbers/strings are supported.
 * Non-animatable strings are also supported.
 */
export class SpringValue<T = any> extends FrameValue<T> {
  /** The property name used when `to` or `from` is an object. Useful when debugging too. */
  key?: string

  /** The animation state */
  animation = new Animation<T>()

  /** The queue of pending props */
  queue?: SpringUpdate<T>[]

  /** The state for `runAsync` calls */
  protected _state: RunAsyncState<SpringValue<T>> = {
    paused: false,
    pauseQueue: new Set(),
    resumeQueue: new Set(),
    timeouts: new Set(),
  }

  /** Some props have customizable default values */
  protected _defaultProps: SpringProps<T> = {}

  /** The counter for tracking `scheduleProps` calls */
  protected _lastCallId = 0

  /** The last `scheduleProps` call that changed the `to` prop */
  protected _lastToId = 0

  constructor(from: Exclude<T, object>, props?: SpringUpdate<T>)
  constructor(props?: SpringUpdate<T>)
  constructor(arg1?: any, arg2?: any) {
    super()
    if (!is.und(arg1) || !is.und(arg2)) {
      const props = is.obj(arg1) ? { ...arg1 } : { ...arg2, from: arg1 }
      props.default = true
      this.start(props)
    }
  }

  /** Equals true when not advancing on each frame. */
  get idle() {
    return !(isAnimating(this) || this._state.asyncTo) || isPaused(this)
  }

  get goal() {
    return getFluidValue(this.animation.to)
  }

  get velocity(): VelocityProp<T> {
    const node = getAnimated(this)!
    return (node instanceof AnimatedValue
      ? node.lastVelocity || 0
      : node.getPayload().map(node => node.lastVelocity || 0)) as any
  }

  /**
   * When true, this value has been animated at least once.
   */
  get hasAnimated() {
    return hasAnimated(this)
  }

  /**
   * When true, this value has an unfinished animation,
   * which is either active or paused.
   */
  get isAnimating() {
    return isAnimating(this)
  }

  /**
   * When true, all current and future animations are paused.
   */
  get isPaused() {
    return isPaused(this)
  }

  /** Advance the current animation by a number of milliseconds */
  advance(dt: number) {
    let idle = true
    let changed = false

    const anim = this.animation
    let { config, toValues } = anim

    const payload = getPayload(anim.to)
    if (!payload) {
      const toConfig = getFluidConfig(anim.to)
      if (toConfig) {
        toValues = toArray(toConfig.get())
      }
    }

    anim.values.forEach((node, i) => {
      if (node.done) return

      const to =
        // Animated strings always go from 0 to 1.
        node.constructor == AnimatedString
          ? 1
          : payload
          ? payload[i].lastPosition
          : toValues![i]

      let finished = anim.immediate
      let position = to

      if (!finished) {
        position = node.lastPosition

        // Loose springs never move.
        if (config.tension <= 0) {
          node.done = true
          return
        }

        const elapsed = (node.elapsedTime += dt)
        const from = anim.fromValues[i]

        const v0 =
          node.v0 != null
            ? node.v0
            : (node.v0 = is.arr(config.velocity)
                ? config.velocity[i]
                : config.velocity)

        let velocity: number

        // Duration easing
        if (!is.und(config.duration)) {
          let p = config.progress || 0
          if (config.duration <= 0) p = 1
          else p += (1 - p) * Math.min(1, elapsed / config.duration)

          position = from + config.easing(p) * (to - from)
          velocity = (position - node.lastPosition) / dt

          finished = p == 1
        }

        // Decay easing
        else if (config.decay) {
          const decay = config.decay === true ? 0.998 : config.decay
          const e = Math.exp(-(1 - decay) * elapsed)

          position = from + (v0 / (1 - decay)) * (1 - e)
          finished = Math.abs(node.lastPosition - position) < 0.1

          // derivative of position
          velocity = v0 * e
        }

        // Spring easing
        else {
          velocity = node.lastVelocity == null ? v0 : node.lastVelocity

          /** The smallest distance from a value before being treated like said value. */
          const precision =
            config.precision ||
            (from == to ? 0.005 : Math.min(1, Math.abs(to - from) * 0.001))

          /** The velocity at which movement is essentially none */
          const restVelocity = config.restVelocity || precision / 10

          // Bouncing is opt-in (not to be confused with overshooting)
          const bounceFactor = config.clamp ? 0 : config.bounce!
          const canBounce = !is.und(bounceFactor)

          /** When `true`, the value is increasing over time */
          const isGrowing = from == to ? node.v0 > 0 : from < to

          /** When `true`, the velocity is considered moving */
          let isMoving!: boolean

          /** When `true`, the velocity is being deflected or clamped */
          let isBouncing = false

          const step = 1 // 1ms
          const numSteps = Math.ceil(dt / step)
          for (let n = 0; n < numSteps; ++n) {
            isMoving = Math.abs(velocity) > restVelocity

            if (!isMoving) {
              finished = Math.abs(to - position) <= precision
              if (finished) {
                break
              }
            }

            if (canBounce) {
              isBouncing = position == to || position > to == isGrowing

              // Invert the velocity with a magnitude, or clamp it.
              if (isBouncing) {
                velocity = -velocity * bounceFactor
                position = to
              }
            }

            const springForce = -config.tension * 0.000001 * (position - to)
            const dampingForce = -config.friction * 0.001 * velocity
            const acceleration = (springForce + dampingForce) / config.mass // pt/ms^2

            velocity = velocity + acceleration * step // pt/ms
            position = position + velocity * step
          }
        }

        node.lastVelocity = velocity

        if (Number.isNaN(position)) {
          console.warn(`Got NaN while animating:`, this)
          finished = true
        }
      }

      // Parent springs must finish before their children can.
      if (payload && !payload[i].done) {
        finished = false
      }

      if (finished) {
        node.done = true
      } else {
        idle = false
      }

      if (node.setValue(position, config.round)) {
        changed = true
      }
    })

    if (idle) {
      this.finish()
    } else if (changed) {
      this._onChange(this.get())
    }
  }

  /** Set the current value, while stopping the current animation */
  set(value: T | FluidValue<T>) {
    this._focus(value)
    G.batchedUpdates(() => {
      this._set(value)
      this._stop()
    })
    return this
  }

  /**
   * Freeze the active animation in time.
   * This does nothing when not animating.
   */
  pause() {
    this._update({ pause: true })
  }

  /** Resume the animation if paused. */
  resume() {
    this._update({ pause: false })
  }

  /** Skip to the end of the current animation. */
  finish() {
    if (isAnimating(this)) {
      const { to, config } = this.animation
      G.batchedUpdates(() => {
        // Ensure the "onStart" and "onRest" props are called.
        this._onStart()

        // Decay animations have an implicit goal.
        if (!config.decay) {
          this._set(to, true)
        }

        // Exit the frameloop.
        this._stop()
      })
    }
    return this
  }

  /** Push props into the pending queue. */
  update(props: SpringUpdate<T>) {
    const queue = this.queue || (this.queue = [])
    queue.push(props)
    return this
  }

  /**
   * Update this value's animation using the queue of pending props,
   * and unpause the current animation (if one is frozen).
   *
   * When arguments are passed, a new animation is created, and the
   * queued animations are left alone.
   */
  start(): AsyncResult<this>

  start(props: SpringUpdate<T>): AsyncResult<this>

  start(to: T, props?: SpringProps<T>): AsyncResult<this>

  start(to?: T | SpringUpdate<T>, arg2?: SpringProps<T>) {
    let queue: SpringUpdate<T>[]
    if (!is.und(to)) {
      queue = [is.obj(to) ? to : { ...arg2, to }]
    } else {
      queue = this.queue || []
      this.queue = []
    }

    return Promise.all(queue.map(props => this._update(props))).then(results =>
      getCombinedResult(this, results)
    )
  }

  /**
   * Stop the current animation, and cancel any delayed updates.
   *
   * Pass `true` to call `onRest` with `cancelled: true`.
   */
  stop(cancel?: boolean) {
    stopAsync(this._state, cancel && this._lastCallId)

    // Ensure the `to` value equals the current value.
    this._focus(this.get())

    // Exit the frameloop and notify `onRest` listeners.
    G.batchedUpdates(() => this._stop(cancel))

    return this
  }

  /** Restart the animation. */
  reset() {
    this._update({ reset: true })
  }

  /** @internal */
  onParentChange(event: FrameValue.Event) {
    if (event.type == 'change') {
      this._start()
    } else if (event.type == 'priority') {
      this.priority = event.priority + 1
    }
  }

  /**
   * Parse the `to` and `from` range from the given `props` object.
   *
   * This also ensures the initial value is available to animated components
   * during the render phase.
   */
  protected _prepareNode(props: {
    to?: any
    from?: any
    reverse?: boolean
    default?: any
  }) {
    const key = this.key || ''

    let { to, from } = props

    to = is.obj(to) ? to[key] : to
    if (to == null || isAsyncTo(to)) {
      to = undefined
    }

    from = is.obj(from) ? from[key] : from
    if (from == null) {
      from = undefined
    }

    // Create the range now to avoid "reverse" logic.
    const range = { to, from }

    // Before ever animating, this method ensures an `Animated` node
    // exists and keeps its value in sync with the "from" prop.
    if (!hasAnimated(this)) {
      if (props.reverse) [to, from] = [from, to]

      from = getFluidValue(from)
      if (!is.und(from)) {
        this._set(from)
      }
      // Use the "to" value if our node is undefined.
      else if (!getAnimated(this)) {
        this._set(to)
      }
    }

    return range
  }

  /** Every update is processed by this method before merging. */
  protected _update(
    { ...props }: SpringProps<T>,
    isLoop?: boolean
  ): AsyncResult<SpringValue<T>> {
    const defaultProps = this._defaultProps

    // Let the caller inspect every update.
    const onProps = resolveEventProp(defaultProps, props, 'onProps', this.key)
    if (onProps) {
      onProps(props, this)
    }

    // Ensure the initial value can be accessed by animated components.
    const range = this._prepareNode(props)

    if (Object.isFrozen(this)) {
      throw Error(
        'Cannot animate a `SpringValue` object that is frozen. ' +
          'Did you forget to pass your component to `animated(...)` before animating its props?'
      )
    }

    const state = this._state
    return scheduleProps(++this._lastCallId, {
      key: this.key,
      props,
      defaultProps,
      state,
      actions: {
        pause: () => {
          if (!isPaused(this)) {
            setPausedBit(this, true)
            flushCalls(state.pauseQueue)
            callProp(this.animation.onPause, this)
          }
        },
        resume: () => {
          if (isPaused(this)) {
            setPausedBit(this, false)
            if (isAnimating(this)) {
              this._resume()
            }
            flushCalls(state.resumeQueue)
            callProp(this.animation.onResume, this)
          }
        },
        start: this._merge.bind(this, range),
      },
    }).then(result => {
      if (props.loop && result.finished && !(isLoop && result.noop)) {
        const nextProps = createLoopUpdate(props)
        if (nextProps) {
          return this._update(nextProps, true)
        }
      }
      return result
    })
  }

  /** Merge props into the current animation */
  protected _merge(
    range: AnimationRange<T>,
    props: RunAsyncProps<SpringValue<T>>,
    resolve: AnimationResolver<SpringValue<T>>
  ): void {
    // The "cancel" prop cancels all pending delays and it forces the
    // active animation to stop where it is.
    if (props.cancel) {
      this.stop(true)
      return resolve(getCancelledResult(this))
    }

    const { key, animation: anim } = this
    const defaultProps = this._defaultProps

    /** The "to" prop is defined. */
    const hasToProp = !is.und(range.to)

    /** The "from" prop is defined. */
    const hasFromProp = !is.und(range.from)

    // Avoid merging other props if implicitly prevented, except
    // when both the "to" and "from" props are undefined.
    if (hasToProp || hasFromProp) {
      if (props.callId > this._lastToId) {
        this._lastToId = props.callId
      } else {
        return resolve(getCancelledResult(this))
      }
    }

    /** Get the function for a specific event prop */
    const getEventProp = <K extends keyof SpringProps>(prop: K) =>
      resolveEventProp(defaultProps, props, prop, key)

    // Call "onDelayEnd" before merging props, but after cancellation checks.
    const onDelayEnd = getEventProp('onDelayEnd')
    if (onDelayEnd) {
      onDelayEnd(props, this)
    }

    if (props.default) {
      mergeDefaultProps(defaultProps, props)
    }

    const { to: prevTo, from: prevFrom } = anim
    let { to = prevTo, from = prevFrom } = range

    // Focus the "from" value if changing without a "to" value.
    // For default updates, do this only if no "to" value exists.
    if (hasFromProp && !hasToProp && (!props.default || is.und(to))) {
      to = from
    }

    // Flip the current range if "reverse" is true.
    if (props.reverse) [to, from] = [from, to]

    /** The "from" value is changing. */
    const hasFromChanged = !isEqual(from, prevFrom)

    if (hasFromChanged) {
      anim.from = from
    }

    /** The "to" value is changing. */
    const hasToChanged = !isEqual(to, prevTo)

    if (hasToChanged) {
      this._focus(to)
    }

    // Both "from" and "to" can use a fluid config (thanks to http://npmjs.org/fluids).
    const toConfig = getFluidConfig(to)
    const fromConfig = getFluidConfig(from)

    if (fromConfig) {
      from = fromConfig.get()
    }

    /** The "to" prop is async. */
    const hasAsyncTo = isAsyncTo(props.to)

    const { config } = anim
    const { decay, velocity } = config

    // The "runAsync" function treats the "config" prop as a default,
    // so we must avoid merging it when the "to" prop is async.
    if (props.config && !hasAsyncTo) {
      mergeConfig(
        config,
        callProp(props.config, key!),
        // Avoid calling the same "config" prop twice.
        props.config !== defaultProps.config
          ? callProp(defaultProps.config, key!)
          : void 0
      )
    }

    // This instance might not have its Animated node yet. For example,
    // the constructor can be given props without a "to" or "from" value.
    let node = getAnimated(this)
    if (!node || is.und(to)) {
      return resolve(getFinishedResult(this, true))
    }

    /** When true, start at the "from" value. */
    const reset =
      // When `reset` is undefined, the `from` prop implies `reset: true`,
      // except for declarative updates. When `reset` is defined, there
      // must exist a value to animate from.
      is.und(props.reset)
        ? hasFromProp && !props.default
        : !is.und(from) && matchProp(props.reset, key)

    // The current value, where the animation starts from.
    const value = reset ? (from as T) : this.get()

    // The animation ends at this value, unless "to" is fluid.
    const goal = computeGoal<any>(to)

    // Only specific types can be animated to/from.
    const isAnimatable = is.num(goal) || is.arr(goal) || isAnimatedString(goal)

    // When true, the value changes instantly on the next frame.
    const immediate =
      !hasAsyncTo &&
      (!isAnimatable ||
        matchProp(defaultProps.immediate || props.immediate, key))

    if (hasToChanged) {
      const nodeType = getAnimatedType(to)
      if (nodeType !== node.constructor) {
        if (immediate) {
          node = this._set(goal)!
        } else
          throw Error(
            `Cannot animate between ${node.constructor.name} and ${nodeType.name}, as the "to" prop suggests`
          )
      }
    }

    // The type of Animated node for the goal value.
    const goalType = node.constructor

    // When the goal value is fluid, we don't know if its value
    // will change before the next animation frame, so it always
    // starts the animation to be safe.
    let started = !!toConfig
    let finished = false

    if (!started) {
      // When true, the current value has probably changed.
      const hasValueChanged = reset || (!hasAnimated(this) && hasFromChanged)

      // When the "to" value or current value are changed,
      // start animating if not already finished.
      if (hasToChanged || hasValueChanged) {
        finished = isEqual(computeGoal(value), goal)
        started = !finished
      }

      // Changing "decay" or "velocity" starts the animation.
      if (
        !isEqual(config.decay, decay) ||
        !isEqual(config.velocity, velocity)
      ) {
        started = true
      }
    }

    // When an active animation changes its goal to its current value:
    if (finished && isAnimating(this)) {
      // Avoid an abrupt stop unless the animation is being reset.
      if (anim.changed && !reset) {
        started = true
      }
      // Stop the animation before its first frame.
      else if (!started) {
        this._stop()
      }
    }

    if (!hasAsyncTo) {
      // Make sure our "toValues" are updated even if our previous
      // "to" prop is a fluid value whose current value is also ours.
      if (started || getFluidConfig(prevTo)) {
        anim.values = node.getPayload()
        anim.toValues = toConfig
          ? null
          : goalType == AnimatedString
          ? [1]
          : toArray(goal)
      }

      if (anim.immediate != immediate) {
        anim.immediate = immediate

        // Ensure the immediate goal is used as from value.
        if (!immediate && !reset) {
          this._set(prevTo)
        }
      }

      // These event props are stored for later in the animation.
      // Only updates that start an animation can change these props.
      if (started) {
        each(
          ['onStart', 'onChange', 'onPause', 'onResume'] as const,
          prop => (anim[prop] = getEventProp(prop) as any)
        )
      }

      // The "reset" prop tries to reuse the old "onRest" prop,
      // unless you defined a new "onRest" prop.
      const onRestQueue = anim.onRest
      const onRest =
        reset && !props.onRest
          ? onRestQueue[0] || noop
          : checkFinishedOnRest(getEventProp('onRest'), this)

      // In most cases, the animation after this one won't reuse our
      // "onRest" prop. Instead, the _default_ "onRest" prop is used
      // when the next animation has an undefined "onRest" prop.
      if (started) {
        anim.onRest = [onRest, checkFinishedOnRest(resolve, this)]

        // Flush the "onRest" queue for the previous animation.
        let onRestIndex = reset ? 0 : 1
        if (onRestIndex < onRestQueue.length) {
          G.batchedUpdates(() => {
            for (; onRestIndex < onRestQueue.length; onRestIndex++) {
              onRestQueue[onRestIndex]()
            }
          })
        }
      }
      // The "onRest" prop is always first, and it can be updated even
      // if a new animation is not started by this update.
      else if (reset || props.onRest) {
        anim.onRest[0] = onRest
      }
    }

    // Update our node even if the animation is idle.
    if (reset) {
      this._set(value)
    }

    if (hasAsyncTo) {
      resolve(runAsync(props.to, props, this._state, this))
    }

    // Start an animation
    else if (started) {
      if (reset) {
        // Must be idle for "onStart" to be called again.
        setActiveBit(this, false)
      }
      this._start()
    }

    // Postpone promise resolution until the animation is finished,
    // so that no-op updates still resolve at the expected time.
    else if (isAnimating(this) && !hasToChanged) {
      anim.onRest.push(checkFinishedOnRest(resolve, this))
    }

    // Resolve our promise immediately.
    else {
      resolve(getNoopResult(this, value))
    }
  }

  /** Update the `animation.to` value, which might be a `FluidValue` */
  protected _focus(value: T | FluidValue<T>) {
    const anim = this.animation
    if (value !== anim.to) {
      if (this._children.size) {
        this._detach()
      }
      anim.to = value
      if (this._children.size) {
        this._attach()
      }
    }
  }

  protected _attach() {
    let priority = 0

    const { to } = this.animation
    const config = getFluidConfig(to)
    if (config) {
      config.addChild(this)
      if (isFrameValue(to)) {
        priority = to.priority + 1
      }
    }

    this.priority = priority
  }

  protected _detach() {
    getFluidConfig(this.animation.to)?.removeChild(this)
  }

  /**
   * Update the current value from outside the frameloop,
   * and return the `Animated` node.
   */
  protected _set(
    arg: T | FluidValue<T>,
    force?: boolean
  ): Animated | undefined {
    const value = getFluidValue(arg) as T
    if (!is.und(value)) {
      const oldNode = getAnimated(this)
      if (force || !oldNode || !isEqual(value, oldNode.getValue())) {
        // Create a new node or update the existing node.
        const nodeType = getAnimatedType(value)
        if (!oldNode || oldNode.constructor != nodeType) {
          setAnimated(this, nodeType.create(value))
        } else {
          oldNode.setValue(value)
        }
        // Never emit a "change" event for the initial value.
        if (oldNode) {
          G.batchedUpdates(() => {
            this._onChange(value, true)
          })
        }
      }
    }
    return getAnimated(this)
  }

  protected _onStart() {
    const anim = this.animation
    if (!anim.changed) {
      anim.changed = true
      callProp(anim.onStart, this)
    }
  }

  protected _onChange(value: T, idle = false) {
    const anim = this.animation

    // The "onStart" prop is called on the first change after entering the
    // frameloop, but never for immediate animations.
    if (!idle) {
      this._onStart()
    }

    callProp(anim.onChange, value, this)
    super._onChange(value, idle)
  }

  // This method resets the animation state (even if already animating) to
  // ensure the latest from/to range is used, and it also ensures this spring
  // is added to the frameloop.
  protected _start() {
    const anim = this.animation

    // Reset the state of each Animated node.
    getAnimated(this)!.reset(getFluidValue(anim.to))

    // Use the current values as the from values.
    if (!anim.immediate) {
      anim.fromValues = anim.values.map(node => node.lastPosition)
    }

    if (!isAnimating(this)) {
      setActiveBit(this, true)

      // Ensure the `onStart` prop will be called.
      anim.changed = false

      // Start animating if not paused.
      if (!isPaused(this)) {
        this._resume()
      }
    }
  }

  protected _resume() {
    // The "skipAnimation" global avoids the frameloop.
    if (G.skipAnimation) {
      this.finish()
    } else {
      G.frameLoop.start(this)
    }
  }

  /**
   * Exit the frameloop and notify `onRest` listeners.
   *
   * Always wrap `_stop` calls with `batchedUpdates`.
   */
  protected _stop(cancel?: boolean) {
    if (isAnimating(this)) {
      setActiveBit(this, false)

      const anim = this.animation
      each(anim.values, node => {
        node.done = true
      })

      this._emit({
        type: 'idle',
        parent: this,
      })

      const onRestQueue = anim.onRest
      if (onRestQueue.length) {
        // Preserve the "onRest" prop when the goal is dynamic.
        anim.onRest = [anim.toValues ? noop : onRestQueue[0]]

        // Never call the "onRest" prop for no-op animations.
        if (!anim.changed) {
          onRestQueue[0] = noop
        }

        each(onRestQueue, onRest => onRest(cancel))
      }
    }
  }
}

/**
 * The "finished" value is determined by each "onRest" handler,
 * based on whether the current value equals the goal value that
 * was calculated at the time the "onRest" handler was set.
 */
function checkFinishedOnRest<T extends SpringValue>(
  onRest: OnRest<T> | undefined,
  spring: T
) {
  const { to } = spring.animation
  return onRest
    ? (cancel?: boolean) => {
        if (cancel) {
          onRest(getCancelledResult(spring))
        } else {
          const goal = computeGoal(to)
          const value = computeGoal(spring.get())
          const finished = isEqual(value, goal)
          onRest(getFinishedResult(spring, finished))
        }
      }
    : noop
}

export function createLoopUpdate<T>(
  props: T & { loop?: any; to?: any; from?: any; reverse?: any },
  loop = props.loop,
  to = props.to
): T | undefined {
  let loopRet = callProp(loop)
  if (loopRet) {
    const overrides = loopRet !== true && inferTo(loopRet)
    const reverse = (overrides || props).reverse
    const reset = !overrides || overrides.reset
    return createUpdate({
      ...props,
      loop,

      // Avoid updating default props when looping.
      default: false,

      // Ensure `pause` is false, so the loop can continue.
      pause: false,

      // For the "reverse" prop to loop as expected, the "to" prop
      // must be undefined. The "reverse" prop is ignored when the
      // "to" prop is an array or function.
      to: !reverse || isAsyncTo(to) ? to : undefined,

      // Avoid defining the "from" prop if a reset is unwanted.
      from: reset ? props.from : undefined,
      reset,

      // The "loop" prop can return a "useSpring" props object to
      // override any of the original props.
      ...overrides,
    })
  }
}

/**
 * Return a new object based on the given `props`.
 *
 * - All non-reserved props are moved into the `to` prop object.
 * - The `keys` prop is set to an array of affected keys,
 *   or `null` if all keys are affected.
 */
export function createUpdate(props: any) {
  const { to, from } = (props = inferTo(props))

  // Collect the keys affected by this update.
  const keys = new Set<string>()

  if (is.obj(to)) findDefined(to, keys)
  if (is.obj(from)) findDefined(from, keys)

  // The "keys" prop helps in applying updates to affected keys only.
  props.keys = keys.size ? Array.from(keys) : null

  return props
}

/**
 * A modified version of `createUpdate` meant for declarative APIs.
 */
export function declareUpdate(props: any) {
  const update = createUpdate(props)
  if (is.und(update.default)) {
    update.default = getDefaultProps(update)
  }
  return update
}

/** Find keys with defined values */
function findDefined(values: Lookup, keys: Set<string>) {
  eachProp(values, (value, key) => value != null && keys.add(key as any))
}

/** Coerce an event prop into a function */
function resolveEventProp<T, P extends keyof SpringProps>(
  defaultProps: SpringProps<T>,
  props: SpringProps<T>,
  prop: P,
  key?: string
): Extract<SpringProps<T>[P], Function> {
  const value: any = resolveProp(props[prop], key)
  return is.und(value) ? resolveProp(defaultProps[prop], key) : value
}
