interface Point {
  x: number
  y: number
}

// some basic 2d geometry
const distance = (p1: Point, p2: Point) => Math.hypot(p1.x - p2.x, p1.y - p2.y)
const midpoint = (p1: Point, p2: Point) => <Point>{ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
const subtract = (p1: Point, p2: Point) => <Point>{ x: p1.x - p2.x, y: p1.y - p2.y }

type Render = (ctx: CanvasRenderingContext2D) => void

export interface Options {
  width: number
  height: number
  render: Render
  padding?: number
  maxZoom?: number
}

// defined outside of action, so we only create a single instance
let resizeObserver: ResizeObserver

// callback lookup is because the scope that the resize observer instance
// is running in isn't always going to be the element that was resized
type ResizeCallback = (entry: ResizeObserverEntry) => void
const resizeCallbacks = new WeakMap<Element, ResizeCallback>()

export function panzoom(canvas: HTMLCanvasElement, options: Options) {
  // created inside of action, so we're SSR friendly
  resizeObserver = resizeObserver || new ResizeObserver(entries => {
    for (const entry of entries) {
      const callback = resizeCallbacks.get(entry.target)
      if (callback) {
        callback(entry)
      }
    }
  })

  const dpr = window.devicePixelRatio
  const ctx = canvas.getContext('2d')!

  let minZoom: number
  let width: number
  let height: number
  let render: Render
  let padding: number
  let maxZoom: number
  let view_width = canvas.width = canvas.clientWidth * dpr
  let view_height = canvas.height = canvas.clientHeight * dpr

  function initialize(options: Options) {
    ({ width, height, render, padding, maxZoom } = { padding: 0, maxZoom: 16, ...options })

    minZoom = Math.min(
      canvas.width / (width + (padding * dpr)),
      canvas.height / (height + (padding * dpr))
    )

    // transform so that 0, 0 is center of image in center of canvas
    ctx.resetTransform()
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.scale(minZoom, minZoom)
    ctx.translate(-width / 2, -height / 2)

    rerender()
  }

  initialize(options)

  resizeCallbacks.set(canvas, entry => {
    const rect = entry.contentRect
    const prev = toImageSpace({ x: view_width / 2, y: view_height / 2 })
    const transform = ctx.getTransform()

    view_width = rect.width * dpr
    view_height = rect.height * dpr

    canvas.width = view_width
    canvas.height = view_height

    minZoom = Math.min(
      canvas.width / (options.width + (padding * dpr)),
      canvas.height / (options.height + (padding * dpr))
    )

    ctx.setTransform(transform)

    const middle = toImageSpace({ x: canvas.width / 2, y: canvas.height / 2 })
    ctx.translate(middle.x - prev.x, middle.y - prev.y)

    rerender()
  })

  resizeObserver.observe(canvas)

  // active pointer count and positions
  const pointers = new Map<number, Point>()

  function onpointerdown(event: PointerEvent) {
    event.stopPropagation()
    canvas.setPointerCapture(event.pointerId)

    const point = pointFromEvent(event)
    pointers.set(event.pointerId, point)
  }

  function onpointerend(event: PointerEvent) {
    event.stopPropagation()
    canvas.releasePointerCapture(event.pointerId)

    pointers.delete(event.pointerId)
    // TODO: add momentum scrolling ...
  }

  function onpointermove(event: PointerEvent) {
    event.stopPropagation()

    // ignore if pointer not pressed
    if (!pointers.has(event.pointerId)) return

    const point = pointFromEvent(event)

    switch (pointers.size) {
      // single pointer move (pan)
      case 1: {
        const prev = pointers.get(event.pointerId)!
        const diff = subtract(toImageSpace(point), toImageSpace(prev))

        moveBy(diff)
        rerender()

        pointers.set(event.pointerId, point)

        break
      }
      // two pointer move (pinch zoom _and_ pan)
      case 2: {
        let points = [...pointers.values()]
        let p1 = toImageSpace(points[0])
        let p2 = toImageSpace(points[1])
        const prev_middle = midpoint(p1, p2)
        const prev_dist = distance(p1, p2)

        pointers.set(event.pointerId, point)

        points = [...pointers.values()]
        p1 = toImageSpace(points[0])
        p2 = toImageSpace(points[1])
        const middle = midpoint(p1, p2)
        const dist = distance(p1, p2)

        // move by distance that midpoint moved
        const diff = subtract(middle, prev_middle)
        moveBy(diff)

        // zoom by ratio of pinch sizes, on current middle
        const zoom = dist / prev_dist
        zoomOn(middle, zoom)

        break
      }
    }
  }

  function onwheel(event: WheelEvent) {
    event.preventDefault()
    event.stopPropagation()

    const point = pointFromEvent(event)
    const z = Math.exp(-event.deltaY / 512)

    zoomOn(toImageSpace(point), z)
  }

  function moveBy(delta: Point) {
    ctx.translate(delta.x, delta.y)
  }

  function zoomOn(point: Point, zoom: number) {
    function scale(value: number) {
      ctx.translate(point.x, point.y)
      ctx.scale(value, value)
      ctx.translate(-point.x, -point.y)
    }

    scale(zoom)

    const transform = ctx.getTransform()

    // limit min zoom to initial image size
    if (transform.a < minZoom) {
      scale(minZoom / transform.a)
    }

    // limit max zoom to "OMG, I see the pixels so large!"
    if (transform.a > maxZoom) {
      scale(maxZoom / transform.a)
    }

    rerender()
  }

  function pointFromEvent(event: PointerEvent | WheelEvent): Point {
    // point is in canvas space
    return { x: event.offsetX * dpr, y: event.offsetY * dpr }
  }

  function toImageSpace(point: Point): Point {
    const inverse = ctx.getTransform().inverse()
    return inverse.transformPoint(point)
  }

  function rerender() {
    ctx.save()
    ctx.resetTransform()
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.restore()

    render(ctx)
  }

  canvas.addEventListener('pointerdown', onpointerdown, { passive: true })
  canvas.addEventListener('pointerup', onpointerend, { passive: true })
  canvas.addEventListener('pointercancel', onpointerend, { passive: true })
  canvas.addEventListener('pointermove', onpointermove, { passive: true })
  canvas.addEventListener('wheel', onwheel)

  return {
    update(options: Options) {
      initialize(options)
    },
    destroy() {
      resizeObserver.unobserve(canvas)
      resizeCallbacks.delete(canvas)

      canvas.removeEventListener('pointerdown', onpointerdown)
      canvas.removeEventListener('pointerup', onpointerend)
      canvas.removeEventListener('pointercancel', onpointerend)
      canvas.removeEventListener('pointermove', onpointermove)
      canvas.removeEventListener('wheel', onwheel)
    }
  }
}
