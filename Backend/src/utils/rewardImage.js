const MAX_REWARD_IMAGE_BYTES = 400 * 1024;

function validateRewardImage(buffer, contentType) {
    if (contentType !== 'image/jpeg') {
        throw new Error('Upload a JPEG reward photo.');
    }
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        throw new Error('Choose a valid reward photo.');
    }
    if (buffer.length > MAX_REWARD_IMAGE_BYTES) {
        throw new Error('Reward photos must be smaller than 400 KB.');
    }
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
        throw new Error('The uploaded file is not a JPEG photo.');
    }
}

export { MAX_REWARD_IMAGE_BYTES, validateRewardImage };
