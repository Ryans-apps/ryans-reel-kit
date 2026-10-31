---
library_name: transformers.js
tags:
- vision
- background-removal
- portrait-matting
license: apache-2.0
pipeline_tag: image-segmentation
---

# MODNet: Trimap-Free Portrait Matting in Real Time

![image/gif](https://cdn-uploads.huggingface.co/production/uploads/61b253b7ac5ecaae3d1efe0c/KdG3M8sltgiX8hOCNn8DT.gif)

For more information, check out the official [repository](https://github.com/ZHKKKe/MODNet) and example [colab](https://colab.research.google.com/drive/1P3cWtg8fnmu9karZHYDAtmm1vj1rgA-f?usp=sharing).

## Usage (Transformers.js)

If you haven't already, you can install the [Transformers.js](https://huggingface.co/docs/transformers.js) JavaScript library from [NPM](https://www.npmjs.com/package/@huggingface/transformers) using:
```bash
npm i @huggingface/transformers
```

You can then use the model for portrait matting, as follows:

```js
import { pipeline } from '@huggingface/transformers';

const segmenter = await pipeline('background-removal', 'Xenova/modnet', { dtype: 'fp32' });
const url = 'https://images.pexels.com/photos/5965592/pexels-photo-5965592.jpeg?auto=compress&cs=tinysrgb&w=1024';
const output = await segmenter(url);
output[0].save('mask.png');
// You can also use `output[0].toCanvas()` or `await output[0].toBlob()` if you would like to access the output without saving.
```

Or with the `AutoModel` and `AutoProcessor` APIs:

```js
import { AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers';

// Load model and processor
const model = await AutoModel.from_pretrained('Xenova/modnet', { dtype: 'fp32' });
const processor = await AutoProcessor.from_pretrained('Xenova/modnet');

// Load image from URL
const url = 'https://images.pexels.com/photos/5965592/pexels-photo-5965592.jpeg?auto=compress&cs=tinysrgb&w=1024';
const image = await RawImage.fromURL(url);

// Pre-process image
const { pixel_values } = await processor(image);

// Predict alpha matte
const { output } = await model({ input: pixel_values });

// Save output mask
const mask = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(image.width, image.height);
mask.save('mask.png');
```

| Input image | Output mask |
|--------|--------|
| ![image/png](https://cdn-uploads.huggingface.co/production/uploads/61b253b7ac5ecaae3d1efe0c/mhmDJgp5GgnbvQnUc2SVI.png) | ![image/png](https://cdn-uploads.huggingface.co/production/uploads/61b253b7ac5ecaae3d1efe0c/H1VBX6dS-xTpg14cl1Zxx.png) | 

---

Note: Having a separate repo for ONNX weights is intended to be a temporary solution until WebML gains more traction. If you would like to make your models web-ready, we recommend converting to ONNX using [🤗 Optimum](https://huggingface.co/docs/optimum/index) and structuring your repo like this one (with ONNX weights located in a subfolder named `onnx`).