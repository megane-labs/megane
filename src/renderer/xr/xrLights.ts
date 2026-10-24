/**
 * Scene lighting for the immersive view.
 *
 * On the desktop the renderer's lights hang in the scene at fixed positions
 * (key, fill, rim and a hemisphere sky). In a session the scene's own
 * transform is the model matrix that puts the structure in the room, so lights
 * left in the scene would turn and travel with the structure, and their
 * targets — not in the scene — would stay at the reference-space origin on the
 * floor: the meshes lit with them (cartoon, surfaces, polyhedra, arrows) would
 * be lit from wherever the structure happens to sit, often from behind. The
 * impostor atoms and bonds light themselves in view space, so they would not.
 *
 * `XRHeadLights` moves the lights onto the XR rig (reference space) for the
 * session and turns the directional ones with the head every frame, so every
 * layer is lit from the viewer's side the way the desktop camera's default
 * view lights it; the hemisphere's sky stays up in the room.
 */

import * as THREE from "three";

interface HungLight {
  light: THREE.Light;
  parent: THREE.Object3D;
  position: THREE.Vector3;
  /** Head-relative direction toward a directional light (unit). */
  direction: THREE.Vector3 | null;
  /** A directional light's target position before the session. */
  target: THREE.Vector3 | null;
}

export class XRHeadLights {
  private hung: HungLight[] = [];

  /** Move the lights directly under `scene` onto `rig`. */
  attach(scene: THREE.Object3D, rig: THREE.Object3D): void {
    if (this.hung.length > 0) return;
    for (const child of [...scene.children]) {
      const light = child as THREE.Light;
      if (!light.isLight) continue;
      const directional = (light as THREE.DirectionalLight).isDirectionalLight
        ? (light as THREE.DirectionalLight)
        : null;
      const direction = directional
        ? directional.position.clone().sub(directional.target.position)
        : null;
      if (direction && direction.lengthSq() < 1e-12) direction.set(0, 0, 1);
      this.hung.push({
        light,
        parent: scene,
        position: light.position.clone(),
        direction: direction?.normalize() ?? null,
        target: directional ? directional.target.position.clone() : null,
      });
      rig.add(light);
      if (directional) {
        directional.target.position.set(0, 0, 0);
        rig.add(directional.target);
      }
    }
  }

  /** Turn the directional lights with the head (reference-space orientation). */
  update(headQuaternion: THREE.Quaternion): void {
    for (const { light, direction } of this.hung) {
      if (direction) light.position.copy(direction).applyQuaternion(headQuaternion);
    }
  }

  /** Put every light back where it hung before {@link attach}. */
  detach(): void {
    for (const { light, parent, position, target } of this.hung) {
      parent.add(light);
      light.position.copy(position);
      const directional = light as THREE.DirectionalLight;
      if (directional.isDirectionalLight && target) {
        // Back out of the scene graph, as on the desktop: three reads the
        // target's world matrix, which nothing updates there any more.
        directional.target.removeFromParent();
        directional.target.position.copy(target);
        directional.target.updateMatrixWorld();
      }
    }
    this.hung = [];
  }
}
