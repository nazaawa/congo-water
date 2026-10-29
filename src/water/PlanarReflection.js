import * as THREE from 'three';

// Half-resolution planar reflection of the scene in the water plane y = h, the way
// three's Reflector sets up its virtual camera. Ultra-Water reflects its island the same
// way; here it carries the forest walls and the boats, which is most of what makes a
// brown river look like one. Objects below the plane are clipped away.
export class PlanarReflection {
  constructor(scale = 0.5) {
    this.scale = scale;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
    this.camera = new THREE.PerspectiveCamera();
    this.textureMatrix = new THREE.Matrix4();
    this.clip = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)];
    this._v = { pos: new THREE.Vector3(), look: new THREE.Vector3(), target: new THREE.Vector3(), rot: new THREE.Matrix4() };
  }

  setSize(w, h) {
    this.target.setSize(Math.max(1, Math.floor(w * this.scale)), Math.max(1, Math.floor(h * this.scale)));
  }

  render(renderer, scene, camera, height = 0, hide = []) {
    const { pos, look, target, rot } = this._v;
    const n = new THREE.Vector3(0, 1, 0);
    const plane = new THREE.Vector3(camera.position.x, height, camera.position.z);
    pos.setFromMatrixPosition(camera.matrixWorld);
    if (pos.y < height) return false;

    const view = plane.clone().sub(pos).reflect(n).negate().add(plane);
    rot.extractRotation(camera.matrixWorld);
    look.set(0, 0, -1).applyMatrix4(rot).add(pos);
    target.subVectors(plane, look).reflect(n).negate().add(plane);

    const vc = this.camera;
    vc.position.copy(view);
    vc.up.set(0, 1, 0).applyMatrix4(rot).reflect(n);
    vc.lookAt(target);
    vc.far = camera.far;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    this.clip[0].constant = -height + 0.05;
    const prevTarget = renderer.getRenderTarget(), prevClip = renderer.clippingPlanes;
    hide.forEach((o) => (o.visible = false));
    renderer.clippingPlanes = this.clip;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, vc);
    renderer.setRenderTarget(prevTarget);
    renderer.clippingPlanes = prevClip;
    hide.forEach((o) => (o.visible = true));
    return true;
  }
}
