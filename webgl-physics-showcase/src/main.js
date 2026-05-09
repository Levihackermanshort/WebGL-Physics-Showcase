(() => {
  "use strict";

  const QUALITY = {
    performance: { label: "Performance", sim: 128, mesh: 120, dpr: 1 },
    balanced: { label: "Balanced", sim: 192, mesh: 170, dpr: 1.35 },
    ultra: { label: "Ultra", sim: 256, mesh: 230, dpr: 1.6 },
  };

  const PRESETS = {
    calm: { label: "Calm", damping: 0.992, waveSpeed: 0.25, drop: 0.45, fresnel: 0.95 },
    lab: { label: "Laboratory", damping: 0.986, waveSpeed: 0.34, drop: 0.75, fresnel: 1.25 },
    storm: { label: "Storm", damping: 0.976, waveSpeed: 0.48, drop: 1.1, fresnel: 1.55 },
    showcase: { label: "GPU Showcase", damping: 0.982, waveSpeed: 0.42, drop: 0.95, fresnel: 1.45 },
  };

  const SPHERE_MATERIALS = {
    ceramic: { label: "Ceramic", color: [0.92, 0.98, 1.0], roughness: 0.04 },
    chrome: { label: "Chrome", color: [0.78, 0.88, 0.96], roughness: 0.0 },
    glass: { label: "Glass", color: [0.62, 0.9, 1.0], roughness: 0.16 },
  };

  const settings = {
    quality: "balanced",
    preset: "showcase",
    paused: false,
    diagnostics: true,
    gravity: true,
    autoRipples: true,
    cinematic: true,
    slowMotion: false,
    brushRadius: 0.04,
    brushStrength: 0.11,
    lightAngle: 0.65,
    sphereMaterial: "ceramic",
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const sphereModel = (x, y, z, r) => [r, 0, 0, 0, 0, r, 0, 0, 0, 0, r, 0, x, y, z, 1];

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }

  function normalize3(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  function cross3(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  function lookAt(eye, center, up) {
    const z = normalize3([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
    const x = normalize3(cross3(up, z));
    const y = cross3(z, x);
    return [
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
      -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
      -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
      1,
    ];
  }

  function shader(gl, type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(s) || "Shader compile error";
      gl.deleteShader(s);
      throw new Error(message);
    }
    return s;
  }

  function program(gl, vertex, fragment) {
    const p = gl.createProgram();
    const vs = shader(gl, gl.VERTEX_SHADER, vertex);
    const fs = shader(gl, gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(p) || "Program link error";
      gl.deleteProgram(p);
      throw new Error(message);
    }
    return p;
  }

  const SHADERS = {
    quadVS: `#version 300 es
      precision highp float;
      in vec2 a_pos;
      out vec2 v_uv;
      void main(){
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }`,
    simFS: `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_state;
      uniform vec2 u_texel;
      uniform float u_damping;
      uniform float u_speed;
      uniform vec3 u_drop;
      uniform float u_radius;
      out vec4 outState;
      void main(){
        vec4 c = texture(u_state, v_uv);
        float h = c.r;
        float vel = c.g;
        float leftH = texture(u_state, v_uv - vec2(u_texel.x, 0.0)).r;
        float rightH = texture(u_state, v_uv + vec2(u_texel.x, 0.0)).r;
        float downH = texture(u_state, v_uv - vec2(0.0, u_texel.y)).r;
        float upH = texture(u_state, v_uv + vec2(0.0, u_texel.y)).r;
        float lap = leftH + rightH + downH + upH - 4.0 * h;
        vel += lap * u_speed;
        vel *= u_damping;
        h += vel;
        h += smoothstep(u_radius, 0.0, distance(v_uv, u_drop.xy)) * u_drop.z;
        h *= 0.9995;
        outState = vec4(h, vel, 0.0, 1.0);
      }`,
    waterVS: `#version 300 es
      precision highp float;
      in vec2 a_pos;
      uniform sampler2D u_state;
      uniform mat4 u_proj;
      uniform mat4 u_view;
      uniform vec2 u_texel;
      out vec3 v_world;
      out vec3 v_normal;
      out vec2 v_uv;
      void main(){
        vec2 uv = a_pos * 0.5 + 0.5;
        float h = texture(u_state, uv).r;
        float hL = texture(u_state, uv - vec2(u_texel.x, 0.0)).r;
        float hR = texture(u_state, uv + vec2(u_texel.x, 0.0)).r;
        float hD = texture(u_state, uv - vec2(0.0, u_texel.y)).r;
        float hU = texture(u_state, uv + vec2(0.0, u_texel.y)).r;
        vec3 n = normalize(vec3((hL - hR) * 8.5, 0.18, (hD - hU) * 8.5));
        vec3 pos = vec3(a_pos.x * 1.34, h * 0.62, a_pos.y * 1.18);
        v_world = pos;
        v_normal = n;
        v_uv = uv;
        gl_Position = u_proj * u_view * vec4(pos, 1.0);
      }`,
    waterFS: `#version 300 es
      precision highp float;
      in vec3 v_world;
      in vec3 v_normal;
      in vec2 v_uv;
      uniform sampler2D u_state;
      uniform vec3 u_camera;
      uniform vec3 u_light;
      uniform float u_time;
      uniform float u_fresnel;
      uniform vec3 u_ball;
      out vec4 color;
      float caustic(vec2 uv, vec3 n){
        vec2 p = uv * 9.5 + n.xz * 0.16;
        float a = sin(p.x * 8.0 + u_time * 1.5 + sin(p.y * 2.0));
        float b = sin(p.y * 10.0 - u_time * 1.2 + sin(p.x * 2.4));
        float c = sin((p.x - p.y) * 6.0 + u_time * 0.85);
        return smoothstep(0.74, 0.98, abs(a + b + c) / 3.0);
      }
      float ceilingReflection(vec2 uv, vec3 n){
        float strips = smoothstep(0.965, 1.0, sin((uv.x + n.x * 0.08) * 34.0) * 0.5 + 0.5);
        float bands = smoothstep(0.94, 1.0, sin((uv.y + n.z * 0.08) * 24.0 + u_time * 0.18) * 0.5 + 0.5);
        float longGlow = smoothstep(0.55, 1.0, uv.y) * smoothstep(0.1, 0.8, sin((uv.x + n.x * 0.05) * 9.0) * 0.5 + 0.5);
        return (strips * 0.50 + bands * 0.22 + longGlow * 0.32) * smoothstep(0.06, 0.76, uv.y);
      }
      void main(){
        vec3 n = normalize(v_normal);
        vec3 v = normalize(u_camera - v_world);
        vec3 l = normalize(u_light);
        vec3 r = reflect(-v, n);
        float h = texture(u_state, v_uv).r;
        float slope = clamp(length(n.xz) * 5.5, 0.0, 1.0);
        float lit = max(dot(n, l), 0.0);
        float fresnel = pow(1.0 - max(dot(n, v), 0.0), 2.35) * u_fresnel;
        float depth = pow(v_uv.y, 1.35);
        float sky = clamp(r.y * 0.5 + 0.5, 0.0, 1.0);
        vec2 ballUv = u_ball.xz * 0.5 + 0.5;
        float ballDist = distance(v_uv, ballUv);
        float contact = smoothstep(0.19, 0.025, ballDist);
        float reflectionMask = smoothstep(0.28, 0.04, ballDist);
        vec3 deep = vec3(0.004, 0.030, 0.066);
        vec3 mid = vec3(0.016, 0.205, 0.345);
        vec3 shallow = vec3(0.060, 0.515, 0.655);
        float evenDepth = 0.50 + depth * 0.20;
        vec3 body = mix(deep, mid, evenDepth);
        body = mix(body, shallow, 0.18 + lit * 0.22 + slope * 0.14 + clamp(h * 1.2, 0.0, 0.14));
        body = mix(body, vec3(0.001, 0.008, 0.014), contact * 0.62);
        vec3 reflected = mix(vec3(0.01, 0.015, 0.032), vec3(0.68, 0.88, 1.0), sky);
        reflected += ceilingReflection(v_uv, n) * vec3(0.7, 0.92, 1.0) * 0.35;
        reflected += reflectionMask * vec3(0.55, 0.72, 0.82) * 0.36;
        float cst = caustic(v_uv, n) * 0.17;
        float crest = smoothstep(0.28, 0.86, slope) * 0.32;
        float spec = pow(max(dot(reflect(-l, n), v), 0.0), 190.0);
        float ring = smoothstep(0.095, 0.07, abs(ballDist - 0.11)) * 0.18;
        float edgeFade = smoothstep(0.0, 0.08, v_uv.x) * smoothstep(1.0, 0.92, v_uv.x) * smoothstep(0.0, 0.08, v_uv.y) * smoothstep(1.0, 0.92, v_uv.y);
        float fineTexture = sin(v_uv.x * 95.0 + u_time * 0.18) * sin(v_uv.y * 87.0 - u_time * 0.12) * 0.018;
        float wetEdgeGlow = (1.0 - edgeFade) * 0.10;
        vec3 c = mix(body, reflected, clamp(fresnel + 0.21, 0.0, 0.96));
        c += cst * vec3(0.45, 0.82, 0.95);
        c += crest * vec3(0.55, 0.96, 1.0);
        c += spec * vec3(1.0, 0.96, 0.76);
        c += ring * vec3(0.38, 0.85, 1.0);
        c += wetEdgeGlow * vec3(0.18, 0.46, 0.56);
        c += fineTexture * vec3(0.10, 0.28, 0.34);
        c = mix(c * 0.84, c, edgeFade);
        c = pow(c, vec3(0.86));
        color = vec4(c, 1.0);
      }`,
    solidVS: `#version 300 es
      precision highp float;
      in vec3 a_pos;
      in vec3 a_normal;
      uniform mat4 u_proj;
      uniform mat4 u_view;
      uniform mat4 u_model;
      out vec3 v_world;
      out vec3 v_normal;
      void main(){
        vec4 world = u_model * vec4(a_pos, 1.0);
        v_world = world.xyz;
        v_normal = mat3(u_model) * a_normal;
        gl_Position = u_proj * u_view * world;
      }`,
    solidFS: `#version 300 es
      precision highp float;
      in vec3 v_world;
      in vec3 v_normal;
      uniform vec3 u_color;
      uniform vec3 u_camera;
      uniform vec3 u_light;
      uniform float u_roughness;
      uniform float u_time;
      out vec4 color;
      float hash(vec2 p){p=fract(p*vec2(234.4,918.2));p+=dot(p,p+31.7);return fract(p.x*p.y);}
      void main(){
        vec3 n = normalize(v_normal);
        vec3 v = normalize(u_camera - v_world);
        vec3 l = normalize(u_light);
        float diff = max(dot(n, l), 0.0);
        float spec = pow(max(dot(reflect(-l, n), v), 0.0), mix(110.0, 16.0, u_roughness));
        float rim = pow(1.0 - max(dot(n, v), 0.0), 2.0);
        float ceilingGlow = smoothstep(1.02, 1.2, v_world.y) * smoothstep(0.88, 1.0, sin(v_world.x * 12.0) * 0.5 + 0.5);
        float dampLine = smoothstep(-0.15, 0.16, -v_world.y);
        float wallPanelX = smoothstep(0.975, 1.0, sin(v_world.x * 10.0) * 0.5 + 0.5);
        float wallPanelZ = smoothstep(0.975, 1.0, sin(v_world.z * 10.0) * 0.5 + 0.5);
        float stain = hash(floor(v_world.xz * 8.0)) * 0.10;
        float wetCorner = smoothstep(1.08, 1.42, abs(v_world.x)) + smoothstep(1.02, 1.30, abs(v_world.z));
        float floorWaterLight = smoothstep(-0.18, -0.10, -abs(v_world.y + 0.16));
        float fakeCaustic = smoothstep(0.78, 1.0, sin(v_world.x * 18.0 + u_time * 1.4) * sin(v_world.z * 16.0 - u_time * 1.1) * 0.5 + 0.5);
        vec3 material = u_color * (0.72 + hash(v_world.xz * 14.0) * 0.22);
        material += ceilingGlow * vec3(0.90, 0.82, 0.50) * 0.42;
        material += stain * vec3(0.10, 0.09, 0.06);
        material -= dampLine * vec3(0.09, 0.10, 0.08);
        material -= (wallPanelX + wallPanelZ) * vec3(0.035, 0.032, 0.026);
        material -= wetCorner * vec3(0.025, 0.035, 0.04);
        vec3 c = material * (0.13 + diff * 0.86) + spec * vec3(1.0, 0.92, 0.68) + rim * 0.16;
        c += floorWaterLight * fakeCaustic * vec3(0.12, 0.34, 0.42);
        float fog = smoothstep(2.2, 4.5, length(v_world - u_camera));
        c = mix(c, vec3(0.015, 0.028, 0.032), fog * 0.38);
        color = vec4(c, 1.0);
      }`,
  };

  class WebGLWaterShowcase {
    constructor(canvas, hudCanvas) {
      this.canvas = canvas;
      this.hudCanvas = hudCanvas;
      this.hud = hudCanvas.getContext("2d");
      this.gl = canvas.getContext("webgl2", { alpha: false, antialias: true });
      this.width = 1;
      this.height = 1;
      this.simSize = 192;
      this.meshSize = 170;
      this.frame = 0;
      this.fps = 60;
      this.fpsLast = performance.now();
      this.start = performance.now();
      this.activeQuality = settings.quality;
      this.dropQueue = [];
      this.pointer = { down: false, dragBall: false, orbitX: 0.12, orbitY: 0.08 };
      this.ball = { x: 0.2, z: 0.05, y: 0.23, vx: 0.002, vz: 0.001 };
      this.raf = 0;
      if (!this.gl) throw new Error("WebGL2 is not supported in this browser.");
      if (!this.gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float is required for GPU water simulation.");
      this.init();
    }

    init() {
      const gl = this.gl;
      this.simProgram = program(gl, SHADERS.quadVS, SHADERS.simFS);
      this.waterProgram = program(gl, SHADERS.waterVS, SHADERS.waterFS);
      this.solidProgram = program(gl, SHADERS.solidVS, SHADERS.solidFS);
      this.makeQuad();
      this.getLocations();
      this.waterMesh = { vao: gl.createVertexArray(), pos: gl.createBuffer(), index: gl.createBuffer(), count: 0 };
      this.sphere = { vao: gl.createVertexArray(), pos: gl.createBuffer(), normal: gl.createBuffer(), index: gl.createBuffer(), count: 0 };
      this.room = { vao: gl.createVertexArray(), pos: gl.createBuffer(), normal: gl.createBuffer(), index: gl.createBuffer(), count: 0 };
      this.makeSphere();
      this.makeRoom();
      this.resize();
      this.bindEvents();
      this.render = this.render.bind(this);
      this.raf = requestAnimationFrame(this.render);
    }

    makeQuad() {
      const gl = this.gl;
      this.quad = { vao: gl.createVertexArray(), buffer: gl.createBuffer() };
      gl.bindVertexArray(this.quad.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const quadPos = gl.getAttribLocation(this.simProgram, "a_pos");
      gl.enableVertexAttribArray(quadPos);
      gl.vertexAttribPointer(quadPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }

    getLocations() {
      const gl = this.gl;
      this.simLoc = {
        state: gl.getUniformLocation(this.simProgram, "u_state"), texel: gl.getUniformLocation(this.simProgram, "u_texel"), damping: gl.getUniformLocation(this.simProgram, "u_damping"),
        speed: gl.getUniformLocation(this.simProgram, "u_speed"), drop: gl.getUniformLocation(this.simProgram, "u_drop"), radius: gl.getUniformLocation(this.simProgram, "u_radius"),
      };
      this.waterLoc = {
        pos: gl.getAttribLocation(this.waterProgram, "a_pos"), state: gl.getUniformLocation(this.waterProgram, "u_state"), proj: gl.getUniformLocation(this.waterProgram, "u_proj"),
        view: gl.getUniformLocation(this.waterProgram, "u_view"), texel: gl.getUniformLocation(this.waterProgram, "u_texel"), camera: gl.getUniformLocation(this.waterProgram, "u_camera"),
        light: gl.getUniformLocation(this.waterProgram, "u_light"), time: gl.getUniformLocation(this.waterProgram, "u_time"), fresnel: gl.getUniformLocation(this.waterProgram, "u_fresnel"),
        ball: gl.getUniformLocation(this.waterProgram, "u_ball"),
      };
      this.solidLoc = {
        pos: gl.getAttribLocation(this.solidProgram, "a_pos"), normal: gl.getAttribLocation(this.solidProgram, "a_normal"), proj: gl.getUniformLocation(this.solidProgram, "u_proj"),
        view: gl.getUniformLocation(this.solidProgram, "u_view"), model: gl.getUniformLocation(this.solidProgram, "u_model"), color: gl.getUniformLocation(this.solidProgram, "u_color"),
        camera: gl.getUniformLocation(this.solidProgram, "u_camera"), light: gl.getUniformLocation(this.solidProgram, "u_light"), roughness: gl.getUniformLocation(this.solidProgram, "u_roughness"),
        time: gl.getUniformLocation(this.solidProgram, "u_time"),
      };
    }

    makeStateTarget(size) {
      const gl = this.gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, null);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { texture, framebuffer };
    }

    resetSimulation(size = this.simSize) {
      const gl = this.gl;
      if (this.ping) {
        gl.deleteTexture(this.ping.texture); gl.deleteFramebuffer(this.ping.framebuffer);
        gl.deleteTexture(this.pong.texture); gl.deleteFramebuffer(this.pong.framebuffer);
      }
      this.simSize = size;
      this.ping = this.makeStateTarget(size);
      this.pong = this.makeStateTarget(size);
      this.source = this.ping;
      this.target = this.pong;
      this.dropQueue.length = 0;
    }

    makeWaterMesh(size) {
      const gl = this.gl;
      this.meshSize = size;
      const positions = [];
      const indices = [];
      for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) positions.push((x / (size - 1)) * 2 - 1, (z / (size - 1)) * 2 - 1);
      for (let z = 0; z < size - 1; z++) for (let x = 0; x < size - 1; x++) {
        const a = z * size + x, b = a + 1, c = a + size, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
      const m = this.waterMesh;
      m.count = indices.length;
      gl.bindVertexArray(m.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.pos);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(this.waterLoc.pos);
      gl.vertexAttribPointer(this.waterLoc.pos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.index);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
    }

    bindSolid(mesh, positions, normals, indices) {
      const gl = this.gl;
      mesh.count = indices.length;
      gl.bindVertexArray(mesh.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.pos);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(this.solidLoc.pos);
      gl.vertexAttribPointer(this.solidLoc.pos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normal);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(this.solidLoc.normal);
      gl.vertexAttribPointer(this.solidLoc.normal, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.index);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
    }

    makeSphere() {
      const p = [], n = [], ind = [], lat = 32, lon = 42;
      for (let y = 0; y <= lat; y++) {
        const theta = (y / lat) * Math.PI;
        for (let x = 0; x <= lon; x++) {
          const phi = (x / lon) * Math.PI * 2;
          const sx = Math.sin(theta) * Math.cos(phi), sy = Math.cos(theta), sz = Math.sin(theta) * Math.sin(phi);
          p.push(sx, sy, sz); n.push(sx, sy, sz);
        }
      }
      for (let y = 0; y < lat; y++) for (let x = 0; x < lon; x++) {
        const a = y * (lon + 1) + x, b = a + 1, c = a + lon + 1, d = c + 1;
        ind.push(a, c, b, b, c, d);
      }
      this.bindSolid(this.sphere, p, n, ind);
    }

    makeRoom() {
      const p = [], n = [], ind = [];
      const quad = (a, b, c, d, normal) => { const base = p.length / 3; p.push(...a, ...b, ...c, ...d); n.push(...normal, ...normal, ...normal, ...normal); ind.push(base, base + 1, base + 2, base, base + 2, base + 3); };
      quad([-1.55, -0.16, -1.35], [1.55, -0.16, -1.35], [1.55, -0.16, 1.35], [-1.55, -0.16, 1.35], [0, 1, 0]);
      quad([-1.55, -0.16, -1.35], [-1.55, 1.25, -1.35], [-1.55, 1.25, 1.35], [-1.55, -0.16, 1.35], [1, 0, 0]);
      quad([1.55, -0.16, -1.35], [1.55, -0.16, 1.35], [1.55, 1.25, 1.35], [1.55, 1.25, -1.35], [-1, 0, 0]);
      quad([-1.55, 1.25, -1.35], [1.55, 1.25, -1.35], [1.55, 1.25, 1.35], [-1.55, 1.25, 1.35], [0, -1, 0]);
      quad([-1.55, -0.16, -1.35], [1.55, -0.16, -1.35], [1.55, 1.25, -1.35], [-1.55, 1.25, -1.35], [0, 0, 1]);
      quad([-1.42, -0.10, -1.18], [1.42, -0.10, -1.18], [1.36, -0.045, -1.10], [-1.36, -0.045, -1.10], [0, 1, 0]);
      quad([-1.42, -0.10, 1.18], [-1.36, -0.045, 1.10], [1.36, -0.045, 1.10], [1.42, -0.10, 1.18], [0, 1, 0]);
      quad([-1.42, -0.10, -1.18], [-1.36, -0.045, -1.10], [-1.36, -0.045, 1.10], [-1.42, -0.10, 1.18], [0, 1, 0]);
      quad([1.42, -0.10, -1.18], [1.42, -0.10, 1.18], [1.36, -0.045, 1.10], [1.36, -0.045, -1.10], [0, 1, 0]);
      this.bindSolid(this.room, p, n, ind);
    }

    queueDrop(u, v, strength, radius = 0.035) {
      this.dropQueue.push({ x: clamp(u, 0, 1), y: clamp(v, 0, 1), strength, radius });
      if (this.dropQueue.length > 48) this.dropQueue.splice(0, this.dropQueue.length - 48);
    }

    queueBurst(u, v) {
      this.queueDrop(u, v, 0.18, 0.055);
      for (let i = 0; i < 18; i++) {
        const angle = (i / 18) * Math.PI * 2;
        const radius = 0.075 + (i % 3) * 0.035;
        this.queueDrop(u + Math.cos(angle) * radius, v + Math.sin(angle) * radius, 0.052, 0.026);
      }
    }

    stepGpuWater() {
      const gl = this.gl;
      const preset = PRESETS[settings.preset];
      if (settings.paused) return;
      if (settings.autoRipples && Math.random() < 0.018 * preset.drop) this.queueDrop(0.12 + Math.random() * 0.76, 0.12 + Math.random() * 0.76, 0.038 * preset.drop, 0.024 + Math.random() * 0.018);
      const nextDrop = this.dropQueue.length ? this.dropQueue.shift() : { x: -10, y: -10, strength: 0, radius: 0.035 };
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.framebuffer);
      gl.viewport(0, 0, this.simSize, this.simSize);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.simProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.source.texture);
      gl.uniform1i(this.simLoc.state, 0);
      gl.uniform2f(this.simLoc.texel, 1 / this.simSize, 1 / this.simSize);
      gl.uniform1f(this.simLoc.damping, preset.damping);
      gl.uniform1f(this.simLoc.speed, settings.slowMotion ? preset.waveSpeed * 0.45 : preset.waveSpeed);
      gl.uniform3f(this.simLoc.drop, nextDrop.x, nextDrop.y, nextDrop.strength);
      gl.uniform1f(this.simLoc.radius, nextDrop.radius);
      gl.bindVertexArray(this.quad.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
      const old = this.source;
      this.source = this.target;
      this.target = old;
    }

    resize() {
      const q = QUALITY[settings.quality];
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, q.dpr);
      this.width = rect.width;
      this.height = rect.height;
      this.canvas.width = Math.max(1, Math.floor(this.width * dpr));
      this.canvas.height = Math.max(1, Math.floor(this.height * dpr));
      this.hudCanvas.width = this.canvas.width;
      this.hudCanvas.height = this.canvas.height;
      this.hudCanvas.style.width = `${this.width}px`;
      this.hudCanvas.style.height = `${this.height}px`;
      this.hud.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.resetSimulation(q.sim);
      this.makeWaterMesh(q.mesh);
    }

    drawHud() {
      const h = this.hud;
      h.clearRect(0, 0, this.width, this.height);
      if (settings.cinematic) {
        const haze = h.createLinearGradient(0, 0, 0, this.height);
        haze.addColorStop(0, "rgba(200,245,255,0.075)");
        haze.addColorStop(0.36, "rgba(34,211,238,0.018)");
        haze.addColorStop(1, "rgba(0,0,0,0)");
        h.fillStyle = haze;
        h.fillRect(0, 0, this.width, this.height);
        const vignette = h.createRadialGradient(this.width * 0.5, this.height * 0.5, this.width * 0.24, this.width * 0.5, this.height * 0.5, this.width * 0.8);
        vignette.addColorStop(0, "rgba(0,0,0,0)");
        vignette.addColorStop(1, "rgba(0,0,0,0.38)");
        h.fillStyle = vignette;
        h.fillRect(0, 0, this.width, this.height);
      }
      if (!settings.diagnostics) return;
      h.fillStyle = "rgba(0,0,0,0.46)";
      h.strokeStyle = "rgba(125,211,252,0.32)";
      roundRect(h, this.width - 230, 22, 205, 238, 16);
      h.fill(); h.stroke();
      h.font = "12px ui-monospace, monospace";
      h.fillStyle = "rgba(186,230,253,0.96)";
      h.fillText(`FPS ${this.fps}`, this.width - 202, 52);
      h.fillText(`SIM ${this.simSize} x ${this.simSize}`, this.width - 202, 76);
      h.fillText(`MESH ${this.meshSize} x ${this.meshSize}`, this.width - 202, 100);
      h.fillText("GPU PING-PONG", this.width - 202, 124);
      h.fillText(`GRAVITY ${settings.gravity ? "ON" : "OFF"}`, this.width - 202, 148);
      h.fillText(`AUTO ${settings.autoRipples ? "ON" : "OFF"}`, this.width - 202, 172);
      h.fillText(`SLOW ${settings.slowMotion ? "ON" : "OFF"}`, this.width - 202, 196);
      h.fillText(`SPHERE ${settings.sphereMaterial.toUpperCase()}`, this.width - 202, 220);
      h.fillText("DBLCLICK BURST", this.width - 202, 244);
    }

    render(now) {
      const gl = this.gl;
      this.frame += 1;
      if (now - this.fpsLast > 500) {
        this.fps = Math.round((this.frame * 1000) / (now - this.fpsLast));
        this.frame = 0;
        this.fpsLast = now;
      }
      if (this.activeQuality !== settings.quality) {
        this.activeQuality = settings.quality;
        this.resize();
      }
      const t = (now - this.start) / 1000;
      const preset = PRESETS[settings.preset];
      this.stepGpuWater();

      if (settings.gravity && !this.pointer.dragBall && !settings.paused) {
        this.ball.vz += 0.00045;
        this.ball.x += this.ball.vx; this.ball.z += this.ball.vz;
        this.ball.vx *= 0.994; this.ball.vz *= 0.994;
        if (this.ball.x < -0.82 || this.ball.x > 0.82) this.ball.vx *= -0.88;
        if (this.ball.z < -0.78 || this.ball.z > 0.82) this.ball.vz *= -0.88;
        this.ball.x = clamp(this.ball.x, -0.82, 0.82);
        this.ball.z = clamp(this.ball.z, -0.78, 0.82);
        if (Math.random() < 0.16) this.queueDrop(this.ball.x * 0.5 + 0.5, this.ball.z * 0.5 + 0.5, 0.018, 0.052);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
      gl.clearColor(0.004, 0.01, 0.018, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const projection = perspective(Math.PI / 3.55, this.canvas.width / this.canvas.height, 0.05, 20);
      const idleDrift = settings.cinematic ? Math.sin(t * 0.22) * 0.028 : 0;
      const eye = [Math.sin((this.pointer.orbitX + idleDrift) * 0.62) * 1.45, 0.62 + this.pointer.orbitY * 0.34 + Math.sin(t * 0.18) * 0.012, 1.72 + Math.cos(t * 0.16) * 0.018];
      const view = lookAt(eye, [0, 0.06, 0], [0, 1, 0]);
      const light = [Math.cos(settings.lightAngle) * 0.72, 1.22, Math.sin(settings.lightAngle) * 0.72];

      gl.useProgram(this.solidProgram);
      gl.uniformMatrix4fv(this.solidLoc.proj, false, new Float32Array(projection));
      gl.uniformMatrix4fv(this.solidLoc.view, false, new Float32Array(view));
      gl.uniform3fv(this.solidLoc.camera, new Float32Array(eye));
      gl.uniform3fv(this.solidLoc.light, new Float32Array(light));
      gl.uniform1f(this.solidLoc.time, t);
      gl.uniformMatrix4fv(this.solidLoc.model, false, new Float32Array(identity()));
      gl.uniform3fv(this.solidLoc.color, new Float32Array([0.34, 0.32, 0.24]));
      gl.uniform1f(this.solidLoc.roughness, 0.82);
      gl.bindVertexArray(this.room.vao);
      gl.drawElements(gl.TRIANGLES, this.room.count, gl.UNSIGNED_INT, 0);

      gl.useProgram(this.waterProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.source.texture);
      gl.uniform1i(this.waterLoc.state, 0);
      gl.uniformMatrix4fv(this.waterLoc.proj, false, new Float32Array(projection));
      gl.uniformMatrix4fv(this.waterLoc.view, false, new Float32Array(view));
      gl.uniform2f(this.waterLoc.texel, 1 / this.simSize, 1 / this.simSize);
      gl.uniform3fv(this.waterLoc.camera, new Float32Array(eye));
      gl.uniform3fv(this.waterLoc.light, new Float32Array(light));
      gl.uniform1f(this.waterLoc.time, t);
      gl.uniform1f(this.waterLoc.fresnel, preset.fresnel);
      gl.uniform3f(this.waterLoc.ball, this.ball.x, this.ball.y, this.ball.z);
      gl.bindVertexArray(this.waterMesh.vao);
      gl.drawElements(gl.TRIANGLES, this.waterMesh.count, gl.UNSIGNED_INT, 0);

      const mat = SPHERE_MATERIALS[settings.sphereMaterial];
      gl.useProgram(this.solidProgram);
      gl.uniformMatrix4fv(this.solidLoc.proj, false, new Float32Array(projection));
      gl.uniformMatrix4fv(this.solidLoc.view, false, new Float32Array(view));
      gl.uniform3fv(this.solidLoc.camera, new Float32Array(eye));
      gl.uniform3fv(this.solidLoc.light, new Float32Array(light));
      gl.uniform1f(this.solidLoc.time, t);
      gl.uniformMatrix4fv(this.solidLoc.model, false, new Float32Array(sphereModel(this.ball.x, this.ball.y, this.ball.z, 0.16)));
      gl.uniform3fv(this.solidLoc.color, new Float32Array(mat.color));
      gl.uniform1f(this.solidLoc.roughness, mat.roughness);
      gl.bindVertexArray(this.sphere.vao);
      gl.drawElements(gl.TRIANGLES, this.sphere.count, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);

      this.drawHud();
      this.raf = requestAnimationFrame(this.render);
    }

    canvasPoint(event) {
      const r = this.canvas.getBoundingClientRect();
      return { x: clamp((event.clientX - r.left) / r.width, 0, 1), y: clamp((event.clientY - r.top) / r.height, 0, 1) };
    }

    toWorld(p) { return { x: clamp((p.x - 0.5) * 2.15, -0.96, 0.96), z: clamp((p.y - 0.5) * 2.05, -0.96, 0.96) }; }
    hitBall(p) { const w = this.toWorld(p); const dx = w.x - this.ball.x; const dz = w.z - this.ball.z; return dx * dx + dz * dz < 0.22; }

    bindEvents() {
      this.onResize = () => this.resize();
      this.onPointerUp = () => { this.pointer.down = false; this.pointer.dragBall = false; };
      this.onPointerDown = (event) => {
        const p = this.canvasPoint(event); const w = this.toWorld(p);
        this.pointer.down = true; this.pointer.dragBall = this.hitBall(p);
        if (this.pointer.dragBall) this.queueDrop(this.ball.x * 0.5 + 0.5, this.ball.z * 0.5 + 0.5, 0.16, 0.065);
        else this.queueDrop(w.x * 0.5 + 0.5, w.z * 0.5 + 0.5, settings.brushStrength * PRESETS[settings.preset].drop, settings.brushRadius);
      };
      this.onDoubleClick = (event) => { const w = this.toWorld(this.canvasPoint(event)); this.queueBurst(w.x * 0.5 + 0.5, w.z * 0.5 + 0.5); };
      this.onPointerMove = (event) => {
        const p = this.canvasPoint(event);
        if (!this.pointer.down) { this.pointer.orbitX = (p.x - 0.5) * 1.6; this.pointer.orbitY = (0.5 - p.y) * 0.82; return; }
        const w = this.toWorld(p);
        if (this.pointer.dragBall) {
          this.ball.vx = (w.x - this.ball.x) * 0.12; this.ball.vz = (w.z - this.ball.z) * 0.12;
          this.ball.x = this.ball.x * 0.35 + w.x * 0.65; this.ball.z = this.ball.z * 0.35 + w.z * 0.65;
          this.queueDrop(this.ball.x * 0.5 + 0.5, this.ball.z * 0.5 + 0.5, 0.055, 0.06);
        } else this.queueDrop(w.x * 0.5 + 0.5, w.z * 0.5 + 0.5, settings.brushStrength * 0.35, settings.brushRadius * 0.75);
      };
      window.addEventListener("resize", this.onResize);
      window.addEventListener("pointerup", this.onPointerUp);
      this.canvas.addEventListener("pointerdown", this.onPointerDown);
      this.canvas.addEventListener("dblclick", this.onDoubleClick);
      this.canvas.addEventListener("pointermove", this.onPointerMove);
      this.canvas.addEventListener("pointerleave", this.onPointerUp);
    }
  }

  function createButtonGroup(container, source, activeKey, onClick, type) {
    container.innerHTML = "";
    Object.entries(source).forEach(([key, item]) => {
      const button = document.createElement("button");
      button.className = type === "material" ? `material-button ${key === activeKey ? "active" : ""}` : `option-card ${key === activeKey ? "active" : ""}`;
      if (type === "material") button.textContent = item.label;
      else button.innerHTML = `<strong>${item.label}</strong><small>${type === "quality" ? `Sim ${item.sim}² / Mesh ${item.mesh}²` : `Speed ${item.waveSpeed.toFixed(2)} / Damping ${item.damping.toFixed(3)}`}</small>`;
      button.addEventListener("click", () => onClick(key));
      container.appendChild(button);
    });
  }

  function updateUi() {
    createButtonGroup(document.getElementById("presetControls"), PRESETS, settings.preset, (key) => { settings.preset = key; updateUi(); }, "preset");
    createButtonGroup(document.getElementById("qualityControls"), QUALITY, settings.quality, (key) => { settings.quality = key; updateUi(); }, "quality");
    createButtonGroup(document.getElementById("materialControls"), SPHERE_MATERIALS, settings.sphereMaterial, (key) => { settings.sphereMaterial = key; updateUi(); }, "material");
    document.getElementById("pauseBtn").textContent = settings.paused ? "Resume" : "Pause";
    document.getElementById("hudBtn").textContent = settings.diagnostics ? "Hide HUD" : "Show HUD";
    document.getElementById("gravityBtn").textContent = settings.gravity ? "Gravity Enabled" : "Gravity Disabled";
    document.getElementById("autoBtn").textContent = settings.autoRipples ? "Auto Ripples" : "Manual Only";
    document.getElementById("cinematicBtn").textContent = settings.cinematic ? "Cinematic On" : "Clean View";
    document.getElementById("slowBtn").textContent = settings.slowMotion ? "Slow Motion On" : "Slow Motion Off";
    document.getElementById("brushRadiusLabel").textContent = settings.brushRadius.toFixed(3);
    document.getElementById("brushStrengthLabel").textContent = settings.brushStrength.toFixed(2);
    document.getElementById("lightAngleLabel").textContent = settings.lightAngle.toFixed(2);
    const q = QUALITY[settings.quality];
    const p = PRESETS[settings.preset];
    document.getElementById("metrics").innerHTML = [
      ["Simulation", `${q.sim}² texture`], ["Render Mesh", `${q.mesh}² grid`], ["State", "height + velocity"], ["Brush", `${settings.brushRadius.toFixed(3)} / ${settings.brushStrength.toFixed(2)}`],
      ["Sphere", SPHERE_MATERIALS[settings.sphereMaterial].label], ["Slow Motion", settings.slowMotion ? "enabled" : "off"], ["Visual Pass", "phase 3"], ["Preset", p.label],
    ].map(([label, value]) => `<div class="metric"><span>${label}</span><span>${value}</span></div>`).join("");
  }

  function bindUi(engine) {
    document.getElementById("pauseBtn").addEventListener("click", () => { settings.paused = !settings.paused; updateUi(); });
    document.getElementById("hudBtn").addEventListener("click", () => { settings.diagnostics = !settings.diagnostics; updateUi(); });
    document.getElementById("gravityBtn").addEventListener("click", () => { settings.gravity = !settings.gravity; updateUi(); });
    document.getElementById("autoBtn").addEventListener("click", () => { settings.autoRipples = !settings.autoRipples; updateUi(); });
    document.getElementById("cinematicBtn").addEventListener("click", () => { settings.cinematic = !settings.cinematic; updateUi(); });
    document.getElementById("slowBtn").addEventListener("click", () => { settings.slowMotion = !settings.slowMotion; updateUi(); });
    document.getElementById("resetBtn").addEventListener("click", () => engine.resetSimulation(engine.simSize));
    document.getElementById("brushRadius").addEventListener("input", (e) => { settings.brushRadius = Number(e.target.value); updateUi(); });
    document.getElementById("brushStrength").addEventListener("input", (e) => { settings.brushStrength = Number(e.target.value); updateUi(); });
    document.getElementById("lightAngle").addEventListener("input", (e) => { settings.lightAngle = Number(e.target.value); updateUi(); });
  }

  window.addEventListener("DOMContentLoaded", () => {
    updateUi();
    try {
      const engine = new WebGLWaterShowcase(document.getElementById("glCanvas"), document.getElementById("hudCanvas"));
      bindUi(engine);
    } catch (error) {
      const hud = document.getElementById("hudCanvas").getContext("2d");
      hud.fillStyle = "white";
      hud.font = "16px sans-serif";
      hud.fillText(error.message || String(error), 24, 36);
      console.error(error);
    }
  });
})();
