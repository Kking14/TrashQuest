export function registerAccount (req, res){
    res.status(200).send("this is your register endpoint");
}

export function loginAccount (req, res){
    res.status(200).send("this is your login endpoint");
}

export function logoutAccount (req, res){
    res.status(200).send("this is your logout endpoint");
}

export function getProfile (req, res){
    res.status(200).send("this is your profile endpoint");
}

export function updatePassword (req, res){
    res.status(200).send("this is your change password endpoint");
}