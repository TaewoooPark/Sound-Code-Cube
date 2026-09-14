import * as THREE from 'three';

/**
 * Continuous front-to-back volume integration of the simulated pressure field.
 * The signed field is interpolated before its magnitude becomes optical density,
 * so opposite waves actually cancel instead of adding colored billboards.
 */
export class PressureVolume {
  readonly object: THREE.Mesh<THREE.BoxGeometry, THREE.RawShaderMaterial>;
  private readonly pressureData: Uint16Array;
  private readonly pressureTexture: THREE.Data3DTexture;
  private readonly paletteData = new Uint16Array(256 * 4);
  private readonly paletteTexture: THREE.DataTexture;

  constructor(private readonly size: number) {
    this.pressureData = new Uint16Array(size ** 3);
    this.pressureTexture = new THREE.Data3DTexture(this.pressureData, size, size, size);
    this.pressureTexture.format = THREE.RedFormat;
    this.pressureTexture.type = THREE.HalfFloatType;
    this.pressureTexture.minFilter = THREE.LinearFilter;
    this.pressureTexture.magFilter = THREE.LinearFilter;
    this.pressureTexture.unpackAlignment = 1;
    this.pressureTexture.needsUpdate = true;
    this.paletteTexture = new THREE.DataTexture(this.paletteData, 256, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    this.paletteTexture.minFilter = THREE.LinearFilter;
    this.paletteTexture.magFilter = THREE.LinearFilter;
    this.paletteTexture.needsUpdate = true;

    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      uniforms: {
        pressureMap: { value: this.pressureTexture },
        paletteMap: { value: this.paletteTexture },
        cameraPos: { value: new THREE.Vector3() },
        normalization: { value: 1 },
        intensity: { value: 1 },
        voxelSize: { value: 1 / size },
        steps: { value: 76 },
        transition: { value: 0 },
        progress: { value: 1 },
        accent: { value: new THREE.Color() },
      },
      vertexShader: `
        precision highp float;
        in vec3 position;
        uniform mat4 modelMatrix;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        uniform vec3 cameraPos;
        out vec3 rayOrigin;
        out vec3 rayDirection;
        void main() {
          rayOrigin = (inverse(modelMatrix) * vec4(cameraPos, 1.0)).xyz;
          rayDirection = position - rayOrigin;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        precision highp sampler3D;
        in vec3 rayOrigin;
        in vec3 rayDirection;
        out vec4 outputColor;
        uniform sampler3D pressureMap;
        uniform sampler2D paletteMap;
        uniform float normalization;
        uniform float intensity;
        uniform float voxelSize;
        uniform float steps;
        uniform float transition;
        uniform float progress;
        uniform vec3 accent;

        vec2 intersectCube(vec3 origin, vec3 direction) {
          vec3 inverseDirection = 1.0 / direction;
          vec3 nearPlanes = (-vec3(1.5) - origin) * inverseDirection;
          vec3 farPlanes = (vec3(1.5) - origin) * inverseDirection;
          vec3 first = min(nearPlanes, farPlanes);
          vec3 last = max(nearPlanes, farPlanes);
          return vec2(max(max(first.x, first.y), first.z), min(min(last.x, last.y), last.z));
        }

        float pressureAt(vec3 position) {
          // Voxel centers correspond exactly to the 33 physical grid nodes.
          vec3 uvw = (position / 3.0 + 0.5) * (1.0 - voxelSize) + voxelSize * 0.5;
          return texture(pressureMap, uvw).r * normalization;
        }

        float densityAt(float pressure) {
          float filled = smoothstep(0.12, 1.3, abs(pressure) * sqrt(intensity));
          return filled * filled;
        }

        vec3 toSRGB(vec3 linearColor) {
          linearColor = max(vec3(0.0), linearColor);
          return mix(1.055 * pow(linearColor, vec3(1.0 / 2.4)) - 0.055,
                     linearColor * 12.92, lessThanEqual(linearColor, vec3(0.0031308)));
        }

        void main() {
          vec3 direction = normalize(rayDirection);
          vec2 interval = intersectCube(rayOrigin, direction);
          if (interval.x > interval.y) discard;
          float start = max(0.0, interval.x);
          float stepLength = (interval.y - start) / steps;
          vec3 position = rayOrigin + direction * (start + stepLength * 0.5);
          vec4 accumulated = vec4(0.0);
          const vec3 lightDirection = vec3(-0.44, 0.78, 0.45);

          for (int i = 0; i < 88; i++) {
            if (float(i) >= steps || accumulated.a > 0.93) break;
            float pressure = pressureAt(position);
            float density = densityAt(pressure);
            // A fraction of one cell softens the volume edge without moving
            // the reflective boundaries or changing the field itself.
            vec3 edge = 1.0 - smoothstep(vec3(1.455), vec3(1.5), abs(position));
            density *= edge.x * edge.y * edge.z;

            if (density > 0.004) {
              float signedAmplitude = pressure * intensity * 0.4;
              float lookup = 0.5 + 0.495 * signedAmplitude * inversesqrt(1.0 + signedAmplitude * signedAmplitude);
              vec3 heatColor = texture(paletteMap, vec2(lookup, 0.5)).rgb;
              float ahead = densityAt(pressureAt(position + lightDirection * 0.11));
              float light = 0.73 + 0.49 * clamp(0.5 + (density - ahead) * 2.0, 0.0, 1.0);
              float sweep = exp(-pow((length(position) - progress * 2.65) / 0.2, 2.0)) * transition;
              heatColor = mix(heatColor, accent, sweep * 0.48);
              heatColor *= light * (1.4 + sweep * 0.32);
              // Beer-Lambert extinction makes opacity independent of the
              // number of ray samples, with correct front-to-back compositing.
              float alpha = 1.0 - exp(-density * stepLength * 2.05);
              float contribution = (1.0 - accumulated.a) * alpha;
              accumulated.rgb += heatColor * contribution;
              accumulated.a += contribution;
            }
            position += direction * stepLength;
          }
          if (accumulated.a < 0.004) discard;
          // Three's normal transparent blending expects straight-alpha output.
          outputColor = vec4(toSRGB(accumulated.rgb / max(accumulated.a, 0.0001)), accumulated.a);
        }
      `,
    });
    this.object = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), material);
    this.object.visible = false;
    this.object.renderOrder = 0;
    this.object.onBeforeRender = (_renderer, _scene, camera) => {
      camera.getWorldPosition(material.uniforms.cameraPos.value);
    };
  }

  setQuality(width: number): void {
    this.object.material.uniforms.steps.value = width < 700 ? 60 : 76;
  }

  updateField(pressure: Float32Array, mean: number, rms: number): void {
    let peak = 0;
    for (let i = 0; i < pressure.length; i++) {
      // The uniform DC mode is a background pressure offset rather than a
      // propagating acoustic wave. Visualize deviations about that equilibrium.
      const value = pressure[i] - mean;
      peak = Math.max(peak, Math.abs(value));
      this.pressureData[i] = THREE.DataUtils.toHalfFloat(Math.max(-65504, Math.min(65504, value)));
    }
    this.object.visible = peak > 0.000025;
    this.object.material.uniforms.normalization.value = 1 / Math.max(0.00025, rms);
    this.pressureTexture.needsUpdate = true;
  }

  setPalette(colors: Float32Array, intensity: number): void {
    for (let i = 0; i < 256; i++) {
      this.paletteData[i * 4] = THREE.DataUtils.toHalfFloat(colors[i * 3]);
      this.paletteData[i * 4 + 1] = THREE.DataUtils.toHalfFloat(colors[i * 3 + 1]);
      this.paletteData[i * 4 + 2] = THREE.DataUtils.toHalfFloat(colors[i * 3 + 2]);
      this.paletteData[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
    }
    this.paletteTexture.needsUpdate = true;
    this.object.material.uniforms.intensity.value = intensity;
  }

  setTransition(progress: number, accent: THREE.Color): void {
    this.object.material.uniforms.progress.value = progress;
    this.object.material.uniforms.transition.value = Math.sin(progress * Math.PI);
    this.object.material.uniforms.accent.value.copy(accent);
  }

  clear(): void {
    this.pressureData.fill(0);
    this.pressureTexture.needsUpdate = true;
    this.object.visible = false;
  }

  /** The parent scene owns the mesh geometry and material. */
  dispose(): void {
    this.pressureTexture.dispose();
    this.paletteTexture.dispose();
  }
}
